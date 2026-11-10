// The site's home page, the sandboxes this browser knows, and a sandbox's landing page: its name, sharing,
// and what's in it. A sign-in's redirect lands here too, and goes back to the viewer that asked for it.
const SANDBOXES_KEY = "smart-imaging-client:sandboxes";
function knownSandboxes() {
  try { return JSON.parse(stored(SANDBOXES_KEY) ?? "[]"); } catch { return []; }
}
const saveSandboxes = list => store(SANDBOXES_KEY, JSON.stringify(list));
const shareLink = base => `${location.origin}${base}/`;
/** The home page: the sandboxes this browser has made or joined, and a way to make another. */
function paintHome(list) {
  $("#sandbox-list").innerHTML = list.length ? list.map(w => `<li><a href="${esc(w.base)}/" data-root><strong>${esc(w.name ?? "Sandbox")}</strong><span>${w.joined ? "Shared with you" : "Made in this browser"}</span></a></li>`).join("") : `<li class="none">You don't have any yet.</li>`;
}
async function renderHome() {
  let list = knownSandboxes();
  // What this browser remembers, straight away, then checked against the server.
  paintHome(list);
  const names = new Map(await Promise.all(list.map(async w => [w.base, await sandboxName(w.base)])));
  // The list as it is now, since one made or joined meanwhile belongs on it. One deleted by whoever made it is
  // gone for everyone; one that couldn't be asked stays, as it was.
  list = knownSandboxes().flatMap(w => { const n = names.get(w.base); return n === null ? [] : [n ? { ...w, name: n } : w]; });
  saveSandboxes(list);
  paintHome(list);
}
$("#create").addEventListener("click", async () => {
  const button = $("#create"), err = $("#create-error");
  button.disabled = true;
  try { location.assign(`${await createSandbox()}/`); } catch (e) { err.hidden = false; err.textContent = e.message; button.disabled = false; }
});
/** Inside a sandbox: its name, and what can be done with it. A browser that hasn't joined it is asked first. */
async function renderSandbox() {
  const box = $("#sandbox");
  const list = knownSandboxes();
  const name = await sandboxName(BASE);
  if (name === null) { box.innerHTML = `<p class="error">This sandbox doesn't exist any more.</p><p><a href="/" data-root>Your sandboxes</a></p>`; return; }
  if (!name) { box.innerHTML = `<p class="error">This sandbox couldn't be reached. Reload to try again.</p><p><a href="/" data-root>Your sandboxes</a></p>`; return; }
  const mine = list.find(w => w.base === BASE);
  if (!mine) {
    box.innerHTML = `<h2>Join “${esc(name)}”?</h2><p class="note">Someone shared this sandbox with you. Anyone with its link can see and change it. It holds sample data only.</p><div class="sandbox-actions"><button type="button" class="primary" id="join">Join this sandbox</button></div>`;
    $("#join").addEventListener("click", () => { saveSandboxes([...knownSandboxes(), { base: BASE, joined: true, name }]); renderSandbox(); });
    return;
  }
  saveSandboxes(list.map(w => w.base === BASE ? { ...w, name } : w));
  box.innerHTML = `<p class="sandbox-label">Sandbox</p><div class="sandbox-head"><p class="sandbox-name" id="sandbox-name">${esc(name)}</p><button type="button" class="tool" id="rename">Rename</button></div>
    <div class="sandbox-actions"><button type="button" class="tool" id="share">Share</button><a class="tool" href="/" data-root>All sandboxes</a><button type="button" class="tool quiet-danger" id="end">${mine.joined ? "Leave" : "Delete"}</button></div>
    <div id="share-panel" hidden><input type="text" id="share-link" readonly aria-label="Link to this sandbox" value="${esc(shareLink(BASE))}"><p class="note" id="share-note">Anyone with this link can see and change this sandbox.</p></div>`;
  $("#rename").addEventListener("click", async () => {
    const next = prompt("Name this sandbox", name);
    if (next === null || !next.trim()) return;
    await api("PATCH", "/api/sandbox", { name: next });
    renderSandbox();
  });
  $("#share").addEventListener("click", async () => {
    const url = shareLink(BASE), panel = $("#share-panel"), note = $("#share-note");
    panel.hidden = false;
    $("#share-link").select();
    if (navigator.share) { try { await navigator.share({ title: `SMART Imaging sandbox: ${name}`, url }); return; } catch (e) { if (e.name === "AbortError") return; } }
    try { await navigator.clipboard.writeText(url); note.textContent = "Link copied. Anyone with it can see and change this sandbox."; } catch {}
  });
  $("#end").addEventListener("click", async () => {
    if (!mine.joined && !confirm(`Delete “${name}” and everything in it? Anyone you shared it with loses it too.`)) return;
    if (!mine.joined) try { await api("DELETE", "/api/sandbox"); } catch {}
    saveSandboxes(knownSandboxes().filter(w => w.base !== BASE));
    try { sessionStorage.removeItem(`smart-imaging-client:${BASE}`); } catch {}
    location.assign("/");
  });
}
// A page brought back by Back is as it was left: a disabled button, or an old list. Bring it up to date.
addEventListener("pageshow", e => {
  if (!e.persisted) return;
  if (!BASE) { $("#create").disabled = false; renderHome(); }
  else renderSandbox();
});
if (!BASE) renderHome(); else renderSandbox();
