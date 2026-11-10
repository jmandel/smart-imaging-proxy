// Opening the viewer on a server, in place. With `connect`, it connects at once: the sign-in tab has to open in
// the click itself, or the browser blocks it, so it's opened here and handed to the viewer, which takes it.
import { router } from "../router";
import { CHOICE_KEY, serverKey, VIEWER_SESSION, type ServerEntry } from "./servers";
import { session, store } from "./store";

let handed: Window | null = null;

export function launchViewer(server: Pick<ServerEntry, "iss" | "clientId" | "mode">, { connect = false } = {}) {
  store(CHOICE_KEY, serverKey(server));
  session.set(VIEWER_SESSION, null);
  handed = connect && server.mode !== "backend" ? open("about:blank", "smart-imaging-sign-in") : null;
  router.navigate("/viewer", { state: connect ? { connect: true } : null });
}
/** The sign-in tab a launch opened, once: the viewer takes it as it connects. */
export function takeSignInTab(): Window | null {
  const tab = handed;
  handed = null;
  return tab;
}
