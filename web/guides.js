// The guides at the site's root. Their links into a sandbox go to the one you were last in, or the newest you
// know, and with none, a click makes one first.
function paintGuide() {
  const w = linkedSandbox(), line = $("#guide-sandbox");
  for (const a of $$("a[data-sandbox]")) { a.dataset.path ??= a.getAttribute("href"); a.href = w ? `${w.base}${a.dataset.path}` : a.dataset.path; }
  for (const el of $$("[data-origin]")) el.textContent = location.origin;
  for (const el of $$("[data-viewer-url]")) el.textContent = VIEWER_URL;
  if (line) line.innerHTML = w ? `Links go to your sandbox “${esc(w.name ?? "Sandbox")}”. <a href="/" data-root>Your sandboxes</a>` : "You don't have a sandbox yet. The first link into one makes it.";
}
document.addEventListener("click", async e => {
  const a = e.target.closest("a[data-sandbox]");
  if (!a || linkedSandbox()) return;
  e.preventDefault();
  try { location.assign(`${await createSandbox()}${a.dataset.path}`); }
  catch (err) { $("#guide-sandbox").textContent = err.message; }
});
paintGuide();
