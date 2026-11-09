// Apps registered in a world: they work there, only there, and a tour leaves them alone.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { addClient, listClients, removeClient } from "../src/clients";
import { createDemoServer } from "../src/demo-server";
import { registerClients } from "../src/flows";
import { CONFIG } from "../src/config";
import { startStack, type Stack } from "../src/stack";

let stack: Stack, demo: ReturnType<typeof createDemoServer>;
beforeAll(async () => { stack = await startStack(join(import.meta.dir, "..")); demo = createDemoServer(stack, registerClients(stack), join(import.meta.dir, "..")); });
afterAll(() => stack.stop());
const call = (method: string, path: string, body?: unknown) => demo.fetch(new Request(`${CONFIG.demoUrl}${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) }));
const REDIRECT = "https://app.example/callback";
const authorize = (w: ReturnType<Stack["scopes"]["mint"]>, client: string, redirect = REDIRECT) => {
  const u = new URL(`${w.urls.auth}/authorize`);
  Object.entries({ client_id: client, redirect_uri: redirect, response_type: "code", state: "s", code_challenge: "c", code_challenge_method: "S256", aud: `${w.urls.auth}/fhir`, scope: "launch/patient patient/*.rs" }).forEach(([k, v]) => u.searchParams.set(k, v));
  return fetch(u, { redirect: "manual" });
};

test("redirect URIs and names are checked", () => {
  const w = stack.scopes.mint();
  for (const redirectUris of [["http://app.example/cb"], ["https://app.example/cb#x"], ["not a url"], []]) expect(addClient(w.store, { name: "A", redirectUris })).toHaveProperty("error");
  expect(addClient(w.store, { name: "", redirectUris: [REDIRECT] })).toHaveProperty("error");
  expect(addClient(w.store, { name: "Local", redirectUris: ["http://localhost:3000/cb"] })).toHaveProperty("id");
});
test("a registered app can start sign-in in its own world, and only with its own redirect", async () => {
  const w = stack.scopes.mint(), other = stack.scopes.mint();
  const r = await call("POST", `${w.prefix}/api/clients`, { name: "My app", redirectUris: [REDIRECT] });
  expect(r.status).toBe(201);
  const { id } = await r.json() as any;
  expect((await authorize(w, id)).status).toBe(200);
  expect((await authorize(w, id, "https://evil.example/cb")).status).toBe(400);
  expect((await authorize(other, id)).status).toBe(400);
  expect((await (await call("GET", `${w.prefix}/api/clients`)).json() as any).clients.map((c: any) => c.id)).toEqual([id]);
});
test("a tour leaves registrations alone, and removal ends them", async () => {
  const w = stack.scopes.mint();
  const c = addClient(w.store, { name: "Kept", redirectUris: [REDIRECT] }) as any;
  expect((await call("POST", `${w.prefix}/api/tours/own/start`, {})).status).toBe(201);
  expect(listClients(w.store).map(x => x.id)).toEqual([c.id]);
  expect(removeClient(w.store, c.id)).toBe(true);
  expect((await authorize(w, c.id)).status).toBe(400);
});
test("the shared root has no registrations", async () => expect((await call("GET", "/api/clients")).status).toBe(409));
