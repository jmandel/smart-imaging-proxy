// The guides at the site's root. Their links into a sandbox go to the one you were last in, or the newest you
// know, and with none, a click makes one first.
const SANDBOXES = "smart-imaging-client:sandboxes";
const known = () => { try { return JSON.parse(localStorage.getItem(SANDBOXES) ?? "[]"); } catch { return []; } };
function guideSandbox() {
  const list = known(), current = currentSandbox();
  return list.find(w => w.base === current) ?? list.at(-1);
}
function paintGuide() {
  const w = guideSandbox(), line = $("#guide-sandbox");
  for (const a of $$("a[data-sandbox]")) a.href = w ? `${w.base}${a.getAttribute("href").replace(/^.*?(\/[^/]*\/?)$/, "$1")}` : a.getAttribute("href");
  for (const el of $$("[data-origin]")) el.textContent = location.origin;
  for (const el of $$("[data-redirect]")) el.textContent = w ? `${location.origin}${w.base}/` : "Open a sandbox to see it";
  if (line) line.innerHTML = w ? `Links go to your sandbox “${esc(w.name ?? "Sandbox")}”. <a href="/" data-root>Your sandboxes</a>` : "You don't have a sandbox yet. The first link you follow makes one.";
}
document.addEventListener("click", async e => {
  const a = e.target.closest("a[data-sandbox]");
  if (!a || guideSandbox()) return;
  e.preventDefault();
  try { const base = await createSandbox(); location.assign(`${base}${a.getAttribute("href")}`); }
  catch (err) { $("#guide-sandbox").textContent = err.message; }
});
paintGuide();
