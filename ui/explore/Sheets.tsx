// The studies, one sheet each: a released one opens, a withheld one says why, and only a released one's
// thumbnail asks for its picture.
import { plural, studyDate } from "../lib/format";
import { Thumbnail, type Pictures } from "../components/Thumbnail";
import type { Sheet } from "./types";

export const sizeOf = (s: Sheet) => `${plural(s.instanceCount ?? 0, "image")} in ${plural(s.seriesCount ?? 0, "series", "series")}`;

function SheetFace({ s, pictures }: { s: Sheet; pictures?: Pictures }) {
  const mod = s.modalities?.[0] ?? "OT", shown = s.released && s.thumb;
  return <>
    <Thumbnail study={shown ? s.id : undefined} from={shown ? pictures : undefined} label={s.title} placeholder={mod} />
    <span className="top"><span className="modality">{(s.modalities ?? [mod]).join(" ")}</span><span className="date">{studyDate(s.date)}</span></span>
    <span className="title">{s.title}</span>
    {s.site && <span className="site">{s.site}</span>}
    <span className={`status ${s.partial ? "partial" : ""}`}>{s.released ? (s.partial ? `Released, ${s.partial}` : sizeOf(s)) : `Withheld: ${s.reason}`}</span>
  </>;
}

/** The sheets. `returnTo` is the one to take focus when they're shown again, on going back from it. */
export function Sheets({ sheets, pictures, open, returnTo }: { sheets: Sheet[]; pictures?: Pictures; open: (id: string) => void; returnTo?: string }) {
  return (
    <ul className="sheets" aria-label="Studies">
      {sheets.map(s => <li key={s.id}>{s.released
        ? <button type="button" className="sheet" data-open={s.id} aria-label={`Open ${s.title}`} autoFocus={s.id === returnTo} onClick={() => open(s.id)}><SheetFace s={s} pictures={pictures} /></button>
        : <div className="sheet withheld"><SheetFace s={s} /></div>}</li>)}
    </ul>
  );
}
