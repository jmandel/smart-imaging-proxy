// Thumbnails, decoded in the browser with viewer-kit. One decoder pool for the page, a reduced decode,
// and the CPU renderer, never a WebGL context per thumbnail. Each slot loads as it scrolls into view,
// a few at a time, and a new view cancels what the old one was still loading. The page says how to get a
// study's picture: Explore retrieves one instance from WADO-RS with its own token, as any app does.
const Thumbs = (() => {
  const KIT = "/vendor/viewer-kit/";
  const LIMIT = 3;
  /** How far to reduce: large radiographs most, CT and MR slices hardly. */
  const SCALE = { CR: 3, DX: 3, MG: 3, XA: 2, US: 1, SM: 2 };
  let poolPromise, controller = new AbortController(), active = 0;
  /** How to get a study's picture: `(study, signal)` gives `{ data, modality }`, or nothing for a study with none. */
  let pictureOf = async () => undefined;
  const waiting = [];
  /** Each study's thumbnail, drawn or on its way, for this view: re-rendering never fetches it twice. */
  const loads = new Map();
  const pool = () => poolPromise ??= import(`${KIT}viewer-kit.js`).then(async kit => ({ kit, pool: await kit.DecoderPool.create({ wasm: `${KIT}shl_dicom_decode.wasm`, workerUrl: `${KIT}decoder-worker.js`, workers: 2 }) }));
  const seen = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) { seen.unobserve(e.target); show(e.target); }
  }, { rootMargin: "200px" });

  /** At most LIMIT at once: the rest wait their turn. */
  const turn = () => new Promise(resolve => { waiting.push(resolve); next(); });
  const next = () => { while (active < LIMIT && waiting.length) { active++; waiting.shift()(); } };
  function load(study, signal) {
    let p = loads.get(study);
    if (!p) {
      p = (async () => {
        await turn();
        try { return await fetchAndDraw(study, signal); } finally { active--; next(); }
      })();
      loads.set(study, p);
      p.catch(() => { if (signal.aborted) loads.delete(study); });
    }
    return p;
  }
  async function fetchAndDraw(study, signal) {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const picture = await pictureOf(study, signal).catch(e => { if (signal.aborted) throw e; return undefined; });
    if (!picture) return null;
    const scale = SCALE[picture.modality] ?? 1;
    const { kit, pool: p } = await pool();
    const img = await p.decode(picture.data, { scale, key: `${study}@1/${2 ** scale}`, signal, priority: kit.Priority.Visible });
    const canvas = document.createElement("canvas");
    canvas.width = img.columns; canvas.height = img.rows;
    const ctx = canvas.getContext("2d");
    const out = ctx.createImageData(img.columns, img.rows);
    const win = kit.defaultWindow(img);
    kit.renderCpu(kit.frameOf(img, 0), { ...kit.defaultView(), windowCenter: win.center, windowWidth: win.width }, img.columns, img.rows, out.data);
    ctx.putImageData(out, 0, 0);
    return canvas;
  }
  async function show(slot) {
    slot.dataset.state = "loading";
    try {
      const canvas = await load(slot.dataset.study, controller.signal);
      if (!slot.isConnected) return;
      if (!canvas) { slot.dataset.state = "none"; return; }
      const copy = document.createElement("canvas");
      copy.width = canvas.width; copy.height = canvas.height;
      copy.setAttribute("role", "img");
      copy.setAttribute("aria-label", `${slot.dataset.label ?? "Study"}: one image from it, reduced`);
      copy.getContext("2d").drawImage(canvas, 0, 0);
      slot.querySelector("canvas")?.remove();
      slot.prepend(copy);
      slot.dataset.state = "drawn";
    } catch { if (slot.isConnected) slot.dataset.state = "failed"; }
  }
  return {
    /** Says how to get a study's picture. */
    use(fn) { pictureOf = fn; },
    /** Shows each slot under `root` that a released study fills, as it scrolls into view. */
    watch(root) { for (const slot of root.querySelectorAll(".thumb[data-study]")) { if (loads.has(slot.dataset.study)) show(slot); else seen.observe(slot); } },
    /** A new view: cancels what's loading, and forgets what was drawn. */
    reset() { controller.abort(); controller = new AbortController(); loads.clear(); seen.disconnect(); },
  };
})();
