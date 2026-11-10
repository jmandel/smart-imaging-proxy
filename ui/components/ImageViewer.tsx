// The image viewer the viewer page and Explore share: series, scrolling through images, brightness and contrast,
// zoom and pan, decoded here with viewer-kit. A page says how to get one instance's bytes, so the viewer can
// retrieve them itself with its token, and Explore through its own session. Images come one at a time: the
// middle one first, then outward, so the first picture doesn't wait for the rest of the series.
// The controls are React state. The canvas, the decoder, prefetching and the pointer are an engine behind a ref,
// which says what the controls should show.
/* eslint-disable @typescript-eslint/no-explicit-any -- viewer-kit is loaded at run time, untyped. */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { NOT_IMAGES, type ImageSource, type ViewerSeries } from "../lib/smart-imaging";

export interface ImageViewerHandle {
  openStudy(series: ViewerSeries[], source: ImageSource): void;
  close(): void;
  note(text: string): void;
  state(): { at: number; zoom: number; panX: number; panY: number } | undefined;
}
type Tool = "window" | "pan";

const KIT = "/vendor/viewer-kit/";
const NEAR = 3, FETCHES_AT_ONCE = 4, ZOOM_STEP = 1.25;
let kitPromise: Promise<{ kit: any; pool: any }> | undefined;
// The address is made at run time, so the bundler leaves the import to the browser: viewer-kit is served as is.
const decoder = () => kitPromise ??= import(new URL(`${KIT}viewer-kit.js`, location.origin).href).then(async kit => ({
  kit, pool: await kit.DecoderPool.create({ wasm: `${KIT}shl_dicom_decode.wasm`, workerUrl: `${KIT}decoder-worker.js` }),
}));
const isAbort = (e: unknown) => (e as Error)?.name === "AbortError";

/** What the controls show. The engine changes it; React draws it. */
interface Controls {
  series: ViewerSeries[];
  selected?: string;
  /** The image shown, and how many there are: none when nothing's open. */
  at: number;
  count: number;
  slidable: boolean;
  overlay: string;
  note: string;
  invert: boolean;
  open: boolean;
}
const CLOSED: Controls = { series: [], at: 0, count: 0, slidable: false, overlay: "", note: "Choose a study.", invert: false, open: false };

interface Slice { instance: string; frame: number }
interface WindowLevel { center: number; width: number }
/** What's open: a series and its images. Replaced whole, so late answers can tell they're stale. */
interface View {
  source: ImageSource; series: ViewerSeries; slices: Slice[]; images: Map<string, Promise<any>>; abort: AbortController;
  at: number; window?: WindowLevel; defaultWindow?: WindowLevel; zoom: number; panX: number; panY: number; invert: boolean;
  shown?: any; started: number; reported: boolean;
}

/** The canvas and everything behind it. It tells the controls what to show through `emit`. */
class Engine {
  private view: View | undefined;
  private renderer: any;
  private drag: { x: number; y: number; panX: number; panY: number; center: number; width: number } | undefined;
  private pinch: { distance: number; middle: { x: number; y: number }; zoom: number; panX: number; panY: number } | undefined;
  private pointers = new Map<number, { x: number; y: number }>();
  private seen: ResizeObserver;
  private source: ImageSource | undefined;
  tool: Tool = "window";

  constructor(private canvas: HTMLCanvasElement, private stage: HTMLElement, private emit: (c: Partial<Controls>) => void, private shown: (ms: number) => void) {
    this.seen = new ResizeObserver(() => { if (this.renderer && canvas.isConnected) { this.sizeCanvas(); this.renderer.draw?.(); } });
    this.seen.observe(canvas);
    stage.addEventListener("wheel", this.onWheel, { passive: false });
    stage.addEventListener("keydown", this.onKey);
    stage.addEventListener("pointerdown", this.onDown);
    stage.addEventListener("pointermove", this.onMove);
    stage.addEventListener("pointerup", this.onUp);
    stage.addEventListener("pointercancel", this.onUp);
  }
  dispose() {
    this.view?.abort.abort(); this.view = undefined;
    this.seen.disconnect();
    const s = this.stage;
    s.removeEventListener("wheel", this.onWheel); s.removeEventListener("keydown", this.onKey);
    s.removeEventListener("pointerdown", this.onDown); s.removeEventListener("pointermove", this.onMove);
    s.removeEventListener("pointerup", this.onUp); s.removeEventListener("pointercancel", this.onUp);
  }

  note = (text: string) => this.emit({ note: text });
  private sizeCanvas() {
    const r = this.canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr)); this.canvas.height = Math.max(1, Math.round(r.height * dpr));
  }

  /** An image, decoded once however many times it's asked for. */
  private imageAt(v: View, i: number, priority: number) {
    const slice = v.slices[i]!;
    let p = v.images.get(slice.instance);
    if (!p) {
      p = (async () => {
        const [{ pool }, data] = await Promise.all([decoder(), v.source.retrieve(v.series, slice.instance, v.abort.signal, seconds => { if (v === this.view) this.note(`The server is preparing these images. Trying again in ${seconds} s…`); })]);
        return pool.decode(data, { key: `${v.series.uid}/${slice.instance}`, priority, signal: v.abort.signal });
      })();
      v.images.set(slice.instance, p);
      p.catch(() => v.images.delete(slice.instance));
    }
    return p;
  }
  private overlayOf = (v: View, img: any) => `${v.series.description ?? v.series.modality ?? ""}\n${img.columns} × ${img.rows}  W ${Math.round(v.window!.width)} C ${Math.round(v.window!.center)}  Zoom ${Math.round(v.zoom * 100)}%`;
  private applyView(kit: any, v: View) {
    this.renderer.setView({ ...kit.defaultView(), windowCenter: v.window!.center, windowWidth: v.window!.width, zoom: v.zoom, panX: v.panX, panY: v.panY, invert: v.invert });
    if (v.shown) this.emit({ overlay: this.overlayOf(v, v.shown) });
  }
  private async show(v: View, i: number) {
    // Where the slider is follows at once; the picture follows when it's decoded.
    v.at = i;
    this.emit({ at: i, count: v.slices.length });
    const { kit } = await decoder();
    let img: any;
    try { img = await this.imageAt(v, i, kit.Priority.Visible); }
    catch (e: any) { if (v === this.view && v.at === i && !isAbort(e)) this.note(e.decoderMessage ?? e.message); return; }
    if (v !== this.view || v.at !== i) return;
    this.renderer ??= (this.sizeCanvas(), kit.createRenderer(this.canvas));
    if (!v.window) { const w = kit.defaultWindow(img); v.window = v.defaultWindow = { center: w.center, width: w.width }; }
    this.renderer.setFrame(kit.frameOf(img, v.slices[i]!.frame), { windowCenter: v.window.center, windowWidth: v.window.width });
    v.shown = img;
    this.applyView(kit, v);
    this.note("");
    if (!v.reported) { v.reported = true; this.shown(Math.round(performance.now() - v.started)); }
    // A single multi-frame instance: its frames become the images.
    if (img.frames > 1 && v.slices.length === 1) {
      v.slices = Array.from({ length: img.frames }, (_, frame) => ({ instance: v.slices[0]!.instance, frame }));
      this.emit({ count: v.slices.length, slidable: true });
    }
  }
  /** Everything else in the series, nearest first, a few at a time. The first few wait for the picture on screen. */
  private async prefetch(v: View, kit: any) {
    const order = v.slices.map((_, i) => i).filter(i => i !== v.at).sort((a, b) => Math.abs(a - v.at) - Math.abs(b - v.at));
    let next = 0;
    const worker = async () => {
      while (v === this.view && next < order.length) {
        const i = order[next++]!;
        try { await this.imageAt(v, i, Math.abs(i - v.at) <= NEAR ? kit.Priority.Near : kit.Priority.Prefetch); } catch {}
      }
    };
    await Promise.all(Array.from({ length: FETCHES_AT_ONCE }, worker));
  }
  async openSeries(series: ViewerSeries) {
    const source = this.source!;
    this.view?.abort.abort();
    const v: View = this.view = { source, series, slices: [], images: new Map(), abort: new AbortController(), at: 0, zoom: 1, panX: 0, panY: 0, invert: false, started: performance.now(), reported: false };
    this.emit({ selected: series.uid, invert: false, overlay: "", note: "Retrieving…", slidable: false, open: true });
    try {
      if (series.modality === "SM") {
        const instance = await source.slideInstance(series, v.abort.signal);
        if (!instance) { this.note("This slide has no small picture to show."); return; }
        v.slices = [{ instance, frame: 0 }];
      } else v.slices = series.instances.map(instance => ({ instance, frame: 0 }));
    } catch (e: any) { if (v === this.view && !isAbort(e)) this.note(e.message); return; }
    if (v !== this.view) return;
    if (!v.slices.length) { this.note("This server didn't list this series' images, which SMART Imaging requires."); return; }
    this.emit({ count: v.slices.length, slidable: v.slices.length > 1 });
    const { kit } = await decoder();
    if (v !== this.view) return;
    await this.show(v, Math.floor((v.slices.length - 1) / 2));
    if (v === this.view && v.slices.length > 1) this.prefetch(v, kit);
  }
  /** A study's series, with the instances' UIDs in order, and how to retrieve their bytes. */
  openStudy(seriesList: ViewerSeries[], source: ImageSource) {
    const images = seriesList.filter(s => !NOT_IMAGES.has(s.modality ?? ""));
    if (!images.length) { this.close(); this.note("This study has no images to show."); return; }
    this.source = source;
    this.emit({ series: images.length > 1 ? images : [] });
    // The series with the most images is usually the one to look at first.
    this.openSeries([...images].sort((a, b) => b.count - a.count)[0]!);
  }
  close() {
    this.view?.abort.abort(); this.view = undefined;
    this.emit({ series: [], selected: undefined, overlay: "", at: 0, count: 0, slidable: false, open: false });
  }

  go(i: number) { if (this.view?.slices.length) this.show(this.view, Math.min(this.view.slices.length - 1, Math.max(0, i))); }
  private step(delta: number) { if (this.view) this.go(this.view.at + delta); }
  private async refresh() { if (!this.view?.window || !this.renderer) return; const { kit } = await decoder(); if (this.view) this.applyView(kit, this.view); }
  zoomBy(factor: number) { if (!this.view) return; this.view.zoom = Math.min(16, Math.max(0.25, this.view.zoom * factor)); this.refresh(); }
  setTool(tool: Tool) { this.tool = tool; this.stage.style.cursor = tool === "pan" ? "move" : ""; }
  toggleInvert() { if (!this.view) return; this.view.invert = !this.view.invert; this.emit({ invert: this.view.invert }); this.refresh(); }
  reset() {
    const v = this.view;
    if (!v?.defaultWindow) return;
    v.window = v.defaultWindow;
    v.zoom = 1; v.panX = 0; v.panY = 0; v.invert = false;
    this.emit({ invert: false });
    this.refresh();
  }
  /** Where the open image is: which one, and how it's zoomed and moved. */
  state() { const v = this.view; return v && { at: v.at, zoom: v.zoom, panX: v.panX, panY: v.panY }; }

  private onWheel = (e: WheelEvent) => {
    if (!this.view) return;
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); this.zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP); return; }
    if (this.view.slices.length < 2) return;
    e.preventDefault(); this.step(Math.sign(e.deltaY));
  };
  private onKey = (e: KeyboardEvent) => {
    const d = ({ ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 } as Record<string, number>)[e.key];
    if (d) { e.preventDefault(); this.step(d); }
    if (e.key === "+" || e.key === "=") this.zoomBy(ZOOM_STEP);
    if (e.key === "-") this.zoomBy(1 / ZOOM_STEP);
  };
  // One finger or the mouse uses the chosen tool. Two fingers pinch to zoom and move the image together.
  /** Where a pointer is, in canvas pixels from the canvas's centre, which is what the renderer's pan is measured from. */
  private fromCentre(e: { clientX: number; clientY: number }) {
    const r = this.canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    return { x: (e.clientX - r.left - r.width / 2) * dpr, y: (e.clientY - r.top - r.height / 2) * dpr };
  }
  private startPinch(v: View) {
    const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
    this.pinch = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), middle: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, zoom: v.zoom, panX: v.panX, panY: v.panY };
    this.drag = undefined;
  }
  private startDrag(v: View, e: { clientX: number; clientY: number }) { this.drag = { x: e.clientX, y: e.clientY, panX: v.panX, panY: v.panY, ...v.window! }; }
  private onDown = (e: PointerEvent) => {
    const v = this.view;
    if (!v?.window) return;
    try { this.stage.setPointerCapture(e.pointerId); } catch {}
    this.pointers.set(e.pointerId, this.fromCentre(e));
    if (this.pointers.size === 2) this.startPinch(v);
    else if (this.pointers.size === 1) this.startDrag(v, e);
  };
  private onMove = (e: PointerEvent) => {
    const v = this.view;
    if (!v?.window || !this.renderer || !this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, this.fromCentre(e));
    const pinch = this.pinch, drag = this.drag;
    if (pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const zoom = Math.min(16, Math.max(0.25, pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / pinch.distance));
      // The point between the fingers stays under them.
      const ratio = zoom / pinch.zoom;
      v.zoom = zoom;
      v.panX = middle.x - (pinch.middle.x - pinch.panX) * ratio;
      v.panY = middle.y - (pinch.middle.y - pinch.panY) * ratio;
      this.refresh();
      return;
    }
    if (!drag) return;
    if (this.tool === "pan") {
      const dpr = devicePixelRatio || 1;
      v.panX = drag.panX + (e.clientX - drag.x) * dpr; v.panY = drag.panY + (e.clientY - drag.y) * dpr;
    } else {
      const gain = Math.max(drag.width, 1) / 400;
      v.window = { width: Math.max(1, drag.width + (e.clientX - drag.x) * gain), center: drag.center + (e.clientY - drag.y) * gain };
    }
    this.refresh();
  };
  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    this.pinch = undefined;
    this.drag = undefined;
    // A finger left after a pinch carries on from where the image is, without a jump.
    const v = this.view;
    if (this.pointers.size === 1 && v?.window) {
      const rest = [...this.pointers.values()][0]!, r = this.canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
      this.startDrag(v, { clientX: rest.x / dpr + r.left + r.width / 2, clientY: rest.y / dpr + r.top + r.height / 2 });
    }
  };
}

/**
 * The viewer. `onShown(ms)` hears how long a series' first picture took. `withIds` gives its parts the ids the
 * viewer page has always had; Explore draws it without them.
 */
export const ImageViewer = forwardRef<ImageViewerHandle, { onShown?: (ms: number) => void; withIds?: boolean }>(function ImageViewer({ onShown, withIds = false }, ref) {
  const canvas = useRef<HTMLCanvasElement>(null), stage = useRef<HTMLDivElement>(null), engine = useRef<Engine>(null);
  const shown = useRef(onShown);
  shown.current = onShown;
  const [c, setControls] = useState<Controls>(CLOSED);
  const [tool, setTool] = useState<Tool>("window");
  useEffect(() => {
    const e = engine.current = new Engine(canvas.current!, stage.current!, patch => setControls(was => ({ ...was, ...patch })), ms => shown.current?.(ms));
    return () => { e.dispose(); engine.current = null; };
  }, []);
  useImperativeHandle(ref, () => ({
    openStudy: (series, source) => engine.current?.openStudy(series, source),
    close: () => engine.current?.close(),
    note: text => engine.current?.note(text),
    state: () => engine.current?.state(),
  }), []);
  const id = (name: string) => withIds ? name : undefined;
  const choose = (t: Tool) => { setTool(t); engine.current?.setTool(t); };
  const slider = <input type="range" id={id("slice")} data-v="slider" min={0} max={Math.max(0, c.count - 1)} value={c.at} disabled={!c.slidable} onInput={e => engine.current?.go(Number(e.currentTarget.value))} />;
  return (
    <>
      <div className="stage" id={id("stage")} data-v="stage" ref={stage} tabIndex={0} aria-label="Image. Arrow keys change the image.">
        <canvas id={id("canvas")} data-v="canvas" ref={canvas} />
        <p className="overlay" id={id("overlay")} data-v="overlay">{c.overlay}</p>
        <p className="stage-note" id={id("stage-note")} data-v="note">{c.note}</p>
      </div>
      <div className="controls">
        {withIds ? <><label htmlFor="slice">Image</label>{slider}</> : <label>Image {slider}</label>}
        <output id={id("slice-out")} htmlFor={id("slice")} data-v="count">{c.count ? `${c.at + 1} / ${c.count}` : ""}</output>
      </div>
      <div className="controls tools" role="group" aria-label="Image tools">
        <button type="button" className="tool" id={id("tool-window")} data-v="tool-window" aria-pressed={tool === "window"} onClick={() => choose("window")}>Window</button>
        <button type="button" className="tool" id={id("tool-pan")} data-v="tool-pan" aria-pressed={tool === "pan"} onClick={() => choose("pan")}>Pan</button>
        <button type="button" className="tool" id={id("zoom-out")} data-v="zoom-out" aria-label="Zoom out" onClick={() => engine.current?.zoomBy(1 / ZOOM_STEP)}>−</button>
        <button type="button" className="tool" id={id("zoom-in")} data-v="zoom-in" aria-label="Zoom in" onClick={() => engine.current?.zoomBy(ZOOM_STEP)}>+</button>
        <button type="button" className="tool" id={id("invert")} data-v="invert" aria-pressed={c.invert} onClick={() => engine.current?.toggleInvert()}>Invert</button>
        <button type="button" className="tool" id={id("reset-view")} data-v="reset" aria-label="Reset view" disabled={!c.open} onClick={() => engine.current?.reset()}>Reset</button>
      </div>
      <p className="touch-hint">Pinch to zoom and move the image. One finger uses the tool above.</p>
      <p className={withIds ? "note hint" : "hint"}>Scroll or use arrow keys to change images. Drag to adjust brightness and contrast, or to pan. Ctrl-scroll zooms.</p>
      <div className="series" id={id("series")} data-v="series" role="group" aria-label="Series">
        {c.series.map(s => <button type="button" key={s.uid} data-uid={s.uid} aria-pressed={s.uid === c.selected} onClick={() => engine.current?.openSeries(s)}>{s.description || `Series ${s.number ?? ""}`} <span>({s.count})</span></button>)}
      </div>
    </>
  );
});
