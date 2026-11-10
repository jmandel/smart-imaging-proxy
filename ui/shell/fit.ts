// A bar that fits its links on one row shows them; one that doesn't collapses behind its button, at whatever
// width and zoom that happens, rather than at a fixed breakpoint, so its row never wraps into a ragged second.
import { useLayoutEffect, type RefObject } from "react";

/** Sets `compact` on the element whenever its contents, laid out on one row, would be wider than it. */
export function useOneRow(ref: RefObject<HTMLElement | null>, deps: unknown[] = []) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Measured on one row, all in one task, so the in-between layout is never painted.
    const fit = () => {
      el.classList.remove("compact");
      el.classList.add("measuring");
      // Past the content edge, padding included: scrollWidth misses contents that only run into the padding.
      const box = el.getBoundingClientRect(), edge = box.left + el.clientLeft + el.clientWidth - parseFloat(getComputedStyle(el).paddingRight);
      const over = [...el.querySelectorAll<HTMLElement>("*")].some(x => x.offsetParent !== null && x.getBoundingClientRect().right > edge + 0.5);
      el.classList.remove("measuring");
      el.classList.toggle("compact", over);
    };
    fit();
    addEventListener("resize", fit);
    document.fonts?.ready.then(fit);
    return () => removeEventListener("resize", fit);
  }, deps);
}
