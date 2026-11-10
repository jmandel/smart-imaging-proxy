// The image viewer the demo app and Explore share: series, scrolling through images, brightness and contrast,
// zoom and pan, decoded here with viewer-kit. A page says how to get one instance's bytes, so the app can
// retrieve them itself with its token, and Explore through its own session. Images come one at a time: the
// middle one first, then outward, so the first picture doesn't wait for the rest of the series.
const ImageViewer = (() => {
  const KIT = "/vendor/viewer-kit/";
  /** Non-image series a viewer has no picture for. */
  const NOT_IMAGES = new Set(["SR", "PR", "KO", "SEG", "RTSTRUCT", "DOC"]);
  const NEAR = 3, FETCHES_AT_ONCE = 4, ZOOM_STEP = 1.25;
  let kitPromise;
  const decoder = () => kitPromise ??= import(`${KIT}viewer-kit.js`).then(async kit => ({ kit, pool: await kit.DecoderPool.create({ wasm: `${KIT}shl_dicom_decode.wasm`, workerUrl: `${KIT}decoder-worker.js` }) }));

  /** The viewer's parts, for a page that draws it rather than writing it into its HTML. */
  const markup = () => `<div class="stage" data-v="stage" tabindex="0" aria-label="Image. Arrow keys change the image.">
      <canvas data-v="canvas"></canvas>
      <p class="overlay" data-v="overlay"></p>
      <p class="stage-note" data-v="note">Choose a study.</p>
    </div>
    <div class="controls">
      <label>Image <input type="range" data-v="slider" min="0" max="0" value="0" disabled></label>
      <output data-v="count"></output>
    </div>
    <div class="controls tools" role="group" aria-label="Image tools">
      <button type="button" class="tool" data-v="tool-window" aria-pressed="true">Window</button>
      <button type="button" class="tool" data-v="tool-pan" aria-pressed="false">Pan</button>
      <button type="button" class="tool" data-v="zoom-out" aria-label="Zoom out">−</button>
      <button type="button" class="tool" data-v="zoom-in" aria-label="Zoom in">+</button>
      <button type="button" class="tool" data-v="invert" aria-pressed="false">Invert</button>
      <button type="button" class="tool" data-v="reset" aria-label="Reset view" disabled>Reset</button>
    </div>
    <p class="touch-hint">Pinch to zoom and move the image. One finger uses the tool above.</p>
    <p class="hint">Scroll or use arrow keys to change images. Drag to adjust brightness and contrast, or to pan. Ctrl-scroll zooms.</p>
    <div class="series" data-v="series" role="group" aria-label="Series"></div>`;

  /**
   * A viewer in `root`, whose parts carry data-v names. `onShown(ms)` hears how long a series' first picture took.
   * Each study opened says how to retrieve an instance's bytes, and a slide's one picture.
   */
  function create(root, { onShown } = {}) {
    const part = name => root.querySelector(`[data-v="${name}"]`);
    const canvas = part("canvas"), stage = part("stage"), slider = part("slider");
    /** What's open: a study's series and its images. Replaced whole, so late answers can tell they're stale. */
    let view, renderer, drag, tool = "window", pinch;
    const pointers = new Map();
    const note = text => { part("note").textContent = text; };

    const sizeCanvas = () => { const r = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1; canvas.width = Math.max(1, Math.round(r.width * dpr)); canvas.height = Math.max(1, Math.round(r.height * dpr)); };
    new ResizeObserver(() => { if (renderer && canvas.isConnected) { sizeCanvas(); renderer.draw?.(); } }).observe(canvas);

    /** An image, decoded once however many times it's asked for. */
    function imageAt(v, i, priority) {
      const slice = v.slices[i];
      let p = v.images.get(slice.instance);
      if (!p) {
        p = (async () => {
          const [{ pool }, data] = await Promise.all([decoder(), v.source.retrieve(v.series, slice.instance, v.abort.signal, seconds => { if (v === view) note(`The server is preparing these images. Trying again in ${seconds} s…`); })]);
          return pool.decode(data, { key: `${v.series.uid}/${slice.instance}`, priority, signal: v.abort.signal });
        })();
        v.images.set(slice.instance, p);
        p.catch(() => v.images.delete(slice.instance));
      }
      return p;
    }
    const writeOverlay = (v, img) => { part("overlay").textContent = `${v.series.description ?? v.series.modality ?? ""}\n${img.columns} × ${img.rows}  W ${Math.round(v.window.width)} C ${Math.round(v.window.center)}  Zoom ${Math.round(v.zoom * 100)}%`; };
    function applyView(kit, v) {
      renderer.setView({ ...kit.defaultView(), windowCenter: v.window.center, windowWidth: v.window.width, zoom: v.zoom, panX: v.panX, panY: v.panY, invert: v.invert });
      if (v.shown) writeOverlay(v, v.shown);
    }
    async function show(v, i) {
      const { kit } = await decoder();
      v.at = i;
      slider.value = String(i);
      part("count").textContent = `${i + 1} / ${v.slices.length}`;
      let img;
      try { img = await imageAt(v, i, kit.Priority.Visible); }
      catch (e) { if (v === view && v.at === i && e.name !== "AbortError") note(e.decoderMessage ?? e.message); return; }
      if (v !== view || v.at !== i) return;
      renderer ??= (sizeCanvas(), kit.createRenderer(canvas));
      if (!v.window) { const w = kit.defaultWindow(img); v.window = v.defaultWindow = { center: w.center, width: w.width }; }
      renderer.setFrame(kit.frameOf(img, v.slices[i].frame), { windowCenter: v.window.center, windowWidth: v.window.width });
      v.shown = img;
      applyView(kit, v);
      note("");
      if (!v.reported) { v.reported = true; onShown?.(Math.round(performance.now() - v.started)); }
      // A single multi-frame instance: its frames become the images.
      if (img.frames > 1 && v.slices.length === 1) {
        v.slices = Array.from({ length: img.frames }, (_, frame) => ({ instance: v.slices[0].instance, frame }));
        slider.max = String(v.slices.length - 1); slider.disabled = false;
        part("count").textContent = `${i + 1} / ${v.slices.length}`;
      }
      writeOverlay(v, img);
    }
    /** Everything else in the series, nearest first, a few at a time. The first few wait for the picture on screen. */
    async function prefetch(v, kit) {
      const order = v.slices.map((_, i) => i).filter(i => i !== v.at).sort((a, b) => Math.abs(a - v.at) - Math.abs(b - v.at));
      let next = 0;
      const worker = async () => {
        while (v === view && next < order.length) {
          const i = order[next++];
          try { await imageAt(v, i, Math.abs(i - v.at) <= NEAR ? kit.Priority.Near : kit.Priority.Prefetch); } catch {}
        }
      };
      await Promise.all(Array.from({ length: FETCHES_AT_ONCE }, worker));
    }
    const syncInvert = () => part("invert").setAttribute("aria-pressed", String(!!view?.invert));
    async function openSeries(source, series) {
      view?.abort.abort();
      const v = view = { source, series, slices: [], images: new Map(), abort: new AbortController(), at: 0, window: undefined, defaultWindow: undefined, zoom: 1, panX: 0, panY: 0, invert: false, started: performance.now(), reported: false };
      syncInvert();
      root.querySelectorAll('[data-v="series"] button').forEach(b => b.setAttribute("aria-pressed", String(b.dataset.uid === series.uid)));
      part("overlay").textContent = ""; note("Retrieving…");
      slider.disabled = true; part("reset").disabled = false;
      try {
        if (series.modality === "SM") {
          const instance = await source.slideInstance(series, v.abort.signal);
          if (!instance) { note("This slide has no small picture to show."); return; }
          v.slices = [{ instance, frame: 0 }];
        } else v.slices = series.instances.map(instance => ({ instance, frame: 0 }));
      } catch (e) { if (v === view && e.name !== "AbortError") note(e.message); return; }
      if (v !== view) return;
      if (!v.slices.length) { note("This server didn't list this series' images, which SMART Imaging requires."); return; }
      slider.max = String(v.slices.length - 1);
      slider.disabled = v.slices.length < 2;
      const { kit } = await decoder();
      if (v !== view) return;
      await show(v, Math.floor((v.slices.length - 1) / 2));
      if (v === view && v.slices.length > 1) prefetch(v, kit);
    }
    /**
     * Opens a study: its series, each `{ uid, number, modality, description, count, instances }` with the
     * instances' UIDs in order, and `source`, `{ retrieve(series, instance, signal, waiting), slideInstance(series, signal) }`.
     */
    function openStudy(seriesList, source) {
      const images = seriesList.filter(s => !NOT_IMAGES.has(s.modality));
      const box = part("series");
      box.innerHTML = images.length > 1 ? images.map(s => `<button type="button" data-uid="${esc(s.uid)}" aria-pressed="false">${esc(s.description || `Series ${s.number ?? ""}`)} <span>(${s.count})</span></button>`).join("") : "";
      box.querySelectorAll("button").forEach(b => b.addEventListener("click", () => openSeries(source, images.find(s => s.uid === b.dataset.uid))));
      if (!images.length) { close(); note("This study has no images to show."); return; }
      // The series with the most images is usually the one to look at first.
      openSeries(source, [...images].sort((a, b) => b.count - a.count)[0]);
    }
    function close() {
      view?.abort.abort(); view = undefined;
      part("series").innerHTML = ""; part("overlay").textContent = ""; part("count").textContent = "";
      slider.disabled = true; part("reset").disabled = true;
    }

    const step = delta => { if (view?.slices.length) show(view, Math.min(view.slices.length - 1, Math.max(0, view.at + delta))); };
    async function refreshView() { if (!view?.window || !renderer) return; const { kit } = await decoder(); applyView(kit, view); }
    const zoomBy = factor => { if (!view) return; view.zoom = Math.min(16, Math.max(0.25, view.zoom * factor)); refreshView(); };
    function setTool(name) { tool = name; part("tool-window").setAttribute("aria-pressed", String(name === "window")); part("tool-pan").setAttribute("aria-pressed", String(name === "pan")); stage.style.cursor = name === "pan" ? "move" : ""; }
    slider.addEventListener("input", () => { if (view) show(view, Number(slider.value)); });
    stage.addEventListener("wheel", e => {
      if (!view) return;
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP); return; }
      if (view.slices.length < 2) return;
      e.preventDefault(); step(Math.sign(e.deltaY));
    }, { passive: false });
    stage.addEventListener("keydown", e => {
      const d = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[e.key];
      if (d) { e.preventDefault(); step(d); }
      if (e.key === "+" || e.key === "=") zoomBy(ZOOM_STEP);
      if (e.key === "-") zoomBy(1 / ZOOM_STEP);
    });
    part("tool-window").addEventListener("click", () => setTool("window"));
    part("tool-pan").addEventListener("click", () => setTool("pan"));
    part("zoom-in").addEventListener("click", () => zoomBy(ZOOM_STEP));
    part("zoom-out").addEventListener("click", () => zoomBy(1 / ZOOM_STEP));
    part("invert").addEventListener("click", () => { if (!view) return; view.invert = !view.invert; syncInvert(); refreshView(); });
    part("reset").addEventListener("click", () => {
      if (!view?.defaultWindow) return;
      view.window = view.defaultWindow;
      view.zoom = 1; view.panX = 0; view.panY = 0; view.invert = false;
      syncInvert();
      refreshView();
    });
    // One finger or the mouse uses the chosen tool. Two fingers pinch to zoom and move the image together.
    /** Where a pointer is, in canvas pixels from the canvas's centre, which is what the renderer's pan is measured from. */
    function fromCentre(e) {
      const r = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
      return { x: (e.clientX - r.left - r.width / 2) * dpr, y: (e.clientY - r.top - r.height / 2) * dpr };
    }
    function startPinch() {
      const [a, b] = [...pointers.values()];
      pinch = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), middle: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, zoom: view.zoom, panX: view.panX, panY: view.panY };
      drag = undefined;
    }
    const startDrag = e => { drag = { x: e.clientX, y: e.clientY, panX: view.panX, panY: view.panY, ...view.window }; };
    stage.addEventListener("pointerdown", e => {
      if (!view?.window) return;
      try { stage.setPointerCapture(e.pointerId); } catch {}
      pointers.set(e.pointerId, fromCentre(e));
      if (pointers.size === 2) startPinch();
      else if (pointers.size === 1) startDrag(e);
    });
    stage.addEventListener("pointermove", e => {
      if (!view?.window || !renderer || !pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, fromCentre(e));
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const zoom = Math.min(16, Math.max(0.25, pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / pinch.distance));
        // The point between the fingers stays under them.
        const ratio = zoom / pinch.zoom;
        view.zoom = zoom;
        view.panX = middle.x - (pinch.middle.x - pinch.panX) * ratio;
        view.panY = middle.y - (pinch.middle.y - pinch.panY) * ratio;
        refreshView();
        return;
      }
      if (!drag) return;
      if (tool === "pan") {
        const dpr = devicePixelRatio || 1;
        view.panX = drag.panX + (e.clientX - drag.x) * dpr; view.panY = drag.panY + (e.clientY - drag.y) * dpr;
      } else {
        const gain = Math.max(drag.width, 1) / 400;
        view.window = { width: Math.max(1, drag.width + (e.clientX - drag.x) * gain), center: drag.center + (e.clientY - drag.y) * gain };
      }
      refreshView();
    });
    function endPointer(e) {
      pointers.delete(e.pointerId);
      pinch = undefined;
      drag = undefined;
      // A finger left after a pinch carries on from where the image is, without a jump.
      if (pointers.size === 1 && view?.window) { const rest = [...pointers.values()][0], r = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1; startDrag({ clientX: rest.x / dpr + r.left + r.width / 2, clientY: rest.y / dpr + r.top + r.height / 2 }); }
    }
    stage.addEventListener("pointerup", endPointer); stage.addEventListener("pointercancel", endPointer);

    /** Where the open image is: which one, and how it's zoomed and moved. */
    const state = () => view && { at: view.at, zoom: view.zoom, panX: view.panX, panY: view.panY };
    return { openStudy, close, note, state };
  }
  return { create, markup, NOT_IMAGES };
})();
