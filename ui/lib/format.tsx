// Small things many pages show the same way.
import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";

export const bytes = (n: unknown) => { const v = Number(n ?? 0); return v >= 1e9 ? `${(v / 1e9).toFixed(2)} GB` : v >= 1e6 ? `${(v / 1e6).toFixed(1)} MB` : v >= 1e3 ? `${(v / 1e3).toFixed(1)} KB` : `${v} B`; };
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const studyDate = (d: unknown) => d ? String(d).slice(0, 10) : "";

/** A list of studies, one per line under its count: study titles carry commas, so they are never joined. */
export function StudyList({ items, lead = `${plural(items.length, "study", "studies")}:` }: { items: string[]; lead?: string }) {
  return <>{lead}<ul className="study-list">{items.map((t, i) => <li key={i}>{t}</li>)}</ul></>;
}

/** A button that copies `value`, read when it's pressed, and says so for a moment. */
export function CopyButton({ label, value, aria }: { label: string; value: string | (() => string); aria?: string }) {
  const [said, setSaid] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try { await navigator.clipboard.writeText(typeof value === "string" ? value : value()); setSaid("Copied"); } catch { setSaid("Couldn't copy"); }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaid(undefined), 2000);
  };
  return <button type="button" className="tool" data-copy={typeof value === "string" ? value : undefined} onClick={copy} aria-label={aria && aria !== label ? aria : undefined}>{said ?? label}</button>;
}

/** The address of the view shown, to hand someone: read as it's pressed, since a page may note a choice in it without a redraw. */
export function LinkToView() {
  return <CopyButton label="Link to this view" value={() => location.href} />;
}

/** A radio or checkbox named by its label alone, with the line beside it as its description, so its accessible
 *  name stays short and stable. `bold` sets the label as a heading over the line, as a list of servers does. */
export function Choice({ label, detail, bold, className, ...input }: { label: string; detail?: ReactNode; bold?: boolean; className?: string } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <label className={className}>
      <input {...input} aria-label={label} aria-describedby={detail ? id : undefined} />
      {bold ? <strong>{label}</strong> : <> {label} </>}
      {detail && <span id={id}>{detail}</span>}
    </label>
  );
}

/** An address to copy: one boxed line, never wrapped, its copy button joined to its end. */
export function Address({ value, name }: { value: string; name: string }) {
  return <span className="addr"><code>{value}</code><CopyButton label="Copy" value={value} aria={`Copy ${name}`} /></span>;
}

/** Says `text` to screen readers, once, through the page's live region. */
export function announce(text: string) {
  const el = document.getElementById("announce");
  if (el) { el.textContent = ""; setTimeout(() => { el.textContent = text; }, 30); }
}
