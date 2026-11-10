// Thumbnails, decoded in the browser with viewer-kit. One decoder pool for the page, a reduced decode, and the
// CPU renderer, never a WebGL context per thumbnail. Each loads as it scrolls into view, a few at a time, and a
// new view cancels what the old one was still loading. The page says how to get a study's picture: Explore
// retrieves one instance from WADO-RS with its own token, as any app does.
/* eslint-disable @typescript-eslint/no-explicit-any -- viewer-kit is loaded at run time, untyped. */
import { useEffect, useRef, useState } from "react";

const KIT = "/vendor/viewer-kit/";
const LIMIT = 3;
/** How far to reduce: large radiographs most, CT and MR slices hardly. */
const SCALE: Record<string, number> = { CR: 3, DX: 3, MG: 3, XA: 2, US: 1, SM: 2 };

// viewer-kit is served as it was downloaded, not bundled: the address is made at run time, so Bun leaves the import alone.
let kitPromise: Promise<{ kit: any; pool: any }> | undefined;
const decoder = () => kitPromise ??= import(new URL(`${KIT}viewer-kit.js`, location.origin).href).then(async (kit: any) => ({
  kit, pool: await kit.DecoderPool.create({ wasm: `${KIT}shl_dicom_decode.wasm`, workerUrl: `${KIT}decoder-worker.js`, workers: 2 }),
}));

/** At most LIMIT at once, across the page: the rest wait their turn. */
let active = 0;
const waiting: (() => void)[] = [];
const next = () => { while (active < LIMIT && waiting.length) { active++; waiting.shift()!(); } };
const turn = () => new Promise<void>(resolve => { waiting.push(resolve); next(); });

/** A study's picture, as the page gets it: an instance's bytes, and its kind of image. */
export interface Picture { data: ArrayBuffer; modality?: string }
/** One view's thumbnails: each study's drawn or on its way, so drawing it again never fetches it twice. */
export interface Pictures { has(study: string): boolean; load(study: string): Promise<HTMLCanvasElement | null>; cancel(): void }

/** The thumbnails for a view, from how to get a study's picture: `undefined` for a study with none. */
export function pictures(pictureOf: (study: string, signal: AbortSignal) => Promise<Picture | undefined>): Pictures {
  const controller = new AbortController(), loads = new Map<string, Promise<HTMLCanvasElement | null>>();
  async function draw(study: string, signal: AbortSignal) {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const picture = await pictureOf(study, signal).catch(e => { if (signal.aborted) throw e; return undefined; });
    if (!picture) return null;
    const scale = SCALE[picture.modality ?? ""] ?? 1;
    const { kit, pool } = await decoder();
    const img = await pool.decode(picture.data, { scale, key: `${study}@1/${2 ** scale}`, signal, priority: kit.Priority.Visible });
    const canvas = document.createElement("canvas");
    canvas.width = img.columns; canvas.height = img.rows;
    const ctx = canvas.getContext("2d")!, out = ctx.createImageData(img.columns, img.rows), win = kit.defaultWindow(img);
    kit.renderCpu(kit.frameOf(img, 0), { ...kit.defaultView(), windowCenter: win.center, windowWidth: win.width }, img.columns, img.rows, out.data);
    ctx.putImageData(out, 0, 0);
    return canvas;
  }
  return {
    has: study => loads.has(study),
    load(study) {
      let p = loads.get(study);
      if (!p) {
        const signal = controller.signal;
        p = (async () => { await turn(); try { return await draw(study, signal); } finally { active--; next(); } })();
        loads.set(study, p);
        p.catch(() => { if (signal.aborted) loads.delete(study); });
      }
      return p;
    },
    cancel: () => controller.abort(),
  };
}

type State = "loading" | "drawn" | "none" | "failed";

/**
 * A study's thumbnail slot: its kind of image until its picture is drawn. `study` and `from` are given only for a
 * study the view may show, so a withheld one's slot asks for nothing.
 */
export function Thumbnail({ study, from, label, placeholder }: { study?: string; from?: Pictures; label: string; placeholder: string }) {
  const slot = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<State>(), [picture, setPicture] = useState<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!study || !from) return;
    let live = true;
    const show = () => {
      setState("loading");
      from.load(study).then(c => { if (!live) return; setPicture(c); setState(c ? "drawn" : "none"); }, () => { if (live) setState("failed"); });
    };
    // One drawn before, as on going back from a study, shows at once.
    if (from.has(study)) { show(); return () => { live = false; }; }
    const seen = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { seen.disconnect(); show(); } }, { rootMargin: "200px" });
    seen.observe(slot.current!);
    return () => { live = false; seen.disconnect(); };
  }, [study, from]);
  const shown = !!(study && from);
  return (
    <div ref={slot} className="thumb" data-study={shown ? study : undefined} data-label={shown ? label : undefined} data-state={state} aria-hidden={!shown}>
      {picture && <canvas role="img" aria-label={`${label}: one image from it, reduced`} width={picture.width} height={picture.height} ref={c => { c?.getContext("2d")!.drawImage(picture, 0, 0); }} />}
      <span className="placeholder">{placeholder}</span>
    </div>
  );
}
