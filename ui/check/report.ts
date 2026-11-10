// A check as a report: Markdown to paste into an issue or a chat, and JSON for a program. Both hold what the page
// shows: the server, how far it got, each step's result, and for a step that failed, its requests and what the
// failure most likely means. Requests are recorded already masked, so no token is in them; a private key never is.
import type { ServerEntry } from "../lib/servers";
import { capital, kindOf, WORD, type Line, type Mark } from "./run";

export interface ReportStep { n: number; title: string; state: Mark; result: string; diagnosis?: { cause: string; check?: string }; requests: { request: string; response: string }[] }
export interface Report { server: Omit<ServerEntry, "jwk" | "sandbox"> & { hasKey?: boolean }; checkedAt: string; summary: string; steps: ReportStep[] }

/** The server as a report names it: everything but its key. */
export const publicServer = ({ jwk, sandbox: _s, ...rest }: ServerEntry & { hasKey?: boolean }): Report["server"] => ({ ...rest, ...(jwk ? { hasKey: true } : {}) });

export function reportSteps(lines: Line[]): ReportStep[] {
  return lines.map((l, i) => {
    const calls = l.trail.steps;
    const diagnosis = l.diagnosis ?? (l.mark === "fail" ? calls.findLast(c => c.diagnosis)?.diagnosis : undefined);
    return { n: i + 1, title: l.title, state: l.mark, result: l.said ? capital(l.said) : WORD[l.mark], ...(diagnosis ? { diagnosis } : {}), requests: calls.map(c => ({ request: c.request ?? "", response: c.response ?? "" })) };
  });
}
export const reportOf = (server: ServerEntry, summary: string, lines: Line[]): Report => ({ server: publicServer(server), checkedAt: new Date().toISOString(), summary, steps: reportSteps(lines) });

const MARK: Record<Mark, string> = { pass: "✓", fail: "✕", skip: "–", note: "○", todo: "·", running: "·", paused: "…", unreached: "·" };
const fence = (text: string) => { const ticks = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1))); return `${ticks}\n${text}\n${ticks}`; };

export function markdown(r: Report): string {
  const s = r.server, out = [
    `# Server check: ${s.label}`, "",
    `- FHIR base: ${s.iss}`,
    `- Client: \`${s.clientId}\`, as a ${kindOf(s)}${s.scope ? `, scope \`${s.scope}\`` : ""}`,
    ...(s.imaging ? [`- Imaging server (set by hand): ${s.imaging}`] : []),
    `- Checked: ${r.checkedAt}`, "",
    `**${r.summary}**`, "",
    ...r.steps.map(x => `${x.n}. ${MARK[x.state]} ${x.title}: ${x.result}${x.state === "fail" ? " (failed)" : ""}`),
  ];
  for (const x of r.steps.filter(x => x.state === "fail")) {
    out.push("", `## Step ${x.n}: ${x.title}`, "", x.result);
    if (x.diagnosis) out.push("", x.diagnosis.cause, ...(x.diagnosis.check ? ["", fence(x.diagnosis.check)] : []));
    for (const q of x.requests) out.push("", "Request:", "", fence(q.request), "", "Response:", "", fence(q.response));
  }
  return `${out.join("\n")}\n`;
}

/** Hands the browser a file to save. */
export function download(name: string, text: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type })), a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
