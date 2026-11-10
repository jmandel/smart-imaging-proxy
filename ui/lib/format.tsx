// Small things many pages show the same way.
import { useEffect, useRef, useState } from "react";

export const bytes = (n: unknown) => { const v = Number(n ?? 0); return v >= 1e9 ? `${(v / 1e9).toFixed(2)} GB` : v >= 1e6 ? `${(v / 1e6).toFixed(1)} MB` : v >= 1e3 ? `${(v / 1e3).toFixed(1)} KB` : `${v} B`; };
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const studyDate = (d: unknown) => d ? String(d).slice(0, 10) : "";

/** A list of studies, one per line under its count: study titles carry commas, so they are never joined. */
export function StudyList({ items, lead = `${plural(items.length, "study", "studies")}:` }: { items: string[]; lead?: string }) {
  return <>{lead}<ul className="study-list">{items.map((t, i) => <li key={i}>{t}</li>)}</ul></>;
}

/** A button that copies `value`, and says so for a moment. */
export function CopyButton({ label, value, aria }: { label: string; value: string; aria?: string }) {
  const [said, setSaid] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setSaid("Copied"); } catch { setSaid("Couldn't copy"); }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaid(undefined), 2000);
  };
  return <button type="button" className="tool" data-copy={value} onClick={copy} aria-label={aria && aria !== label ? aria : undefined}>{said ?? label}</button>;
}

/** Says `text` to screen readers, once, through the page's live region. */
export function announce(text: string) {
  const el = document.getElementById("announce");
  if (el) { el.textContent = ""; setTimeout(() => { el.textContent = text; }, 30); }
}
