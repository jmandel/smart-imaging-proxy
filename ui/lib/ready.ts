// `html[data-ready]`, for anyone driving the site in a browser: there once the page at the address has drawn its
// first real content, and gone while a page or a new view in its address is still loading. A page that loads
// data says when it has it with `useReady`; a page that doesn't is ready as soon as it's drawn.
import { useLayoutEffect, useRef } from "react";

/** The pages, or parts of one, still loading what they first show. */
const waiting = new Set<object>();
/** The address whose page is drawn, and the address the router is at, which leads it during a change of page. */
let drawn = "";
let target = () => drawn;
let queued = false;

// Settled once per task, so the moment between one page going and the next arriving never reads as ready.
function schedule() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    const root = document.documentElement;
    if (!waiting.size && drawn === target()) root.dataset.ready = "true";
    else delete root.dataset.ready;
  });
}

/** For the router: where it's going, read whenever readiness is settled. */
export function followAddress(at: () => string) { target = at; }
/** For the router: the address changed, so the page there isn't drawn yet. */
export const addressChanged = schedule;
/** The page at `address` has been drawn. */
export function useDrawn(address: string) {
  useLayoutEffect(() => { drawn = address; schedule(); }, [address]);
}

/** A page, or a part of one, that's ready only once `done`: its first data has arrived, or failed and said so. */
export function useReady(done: boolean) {
  const me = useRef({}).current;
  useLayoutEffect(() => {
    if (done) waiting.delete(me); else waiting.add(me);
    schedule();
  }, [done]);
  useLayoutEffect(() => () => { waiting.delete(me); schedule(); }, []);
}
