// A change that needs choices first: which sites a person approves the app for, or whom they share with and how.
import type { FormEvent } from "react";
import type { Action, Cast } from "./types";

export type Submitted = { sites: string[]; with?: string; relationship?: string };

/** Whether an action asks for choices before it's made, rather than being made at once. */
export const needsForm = (a: Action) => a.kind === "approve" || (a.kind === "share" && (!a.with || a.sites.length > 1));

function Sites({ sites, ticked, first }: { sites: string[]; ticked: string[]; first: boolean }) {
  return (
    <fieldset><legend>Sites</legend>
      <div className="ticks">
        {sites.length ? sites.map((s, i) => <label key={s}><input type="checkbox" name="site" value={s} defaultChecked={ticked.includes(s)} autoFocus={first && i === 0} /> {s}</label>) : <span className="note">No sites to choose.</span>}
      </div>
    </fieldset>
  );
}

export function ActionForm({ action: a, cast, submit, cancel }: { action: Action; cast: Cast; submit: (f: Submitted) => void; cancel: () => void }) {
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    submit({ sites: f.getAll("site").map(String), with: f.get("with")?.toString(), relationship: f.get("relationship")?.toString() });
  };
  const buttons = (verb: string) => <div className="buttons"><button className="primary" type="submit">{verb}</button><button className="secondary" type="button" onClick={cancel}>Cancel</button></div>;
  if (a.kind === "approve") return (
    <form className="form" id="action-form" onSubmit={onSubmit}>
      <p className="eyebrow">The {cast.app}</p>
      <Sites sites={a.sites} ticked={a.ticked ?? a.sites} first />
      {buttons("Approve")}
    </form>
  );
  if (a.kind === "share") return (
    <form className="form" id="action-form" onSubmit={onSubmit}>
      <p className="eyebrow">{cast.names[`user:${a.from}`] ?? a.from} shares</p>
      {!a.with && <label className="field">Share with <select name="with" autoFocus>{(a.people ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
      <label className="field">As their <select name="relationship" autoFocus={!!a.with}>{cast.relationships.map(r => <option key={r}>{r}</option>)}</select></label>
      <Sites sites={a.sites} ticked={a.sites} first={false} />
      {buttons("Share")}
    </form>
  );
  return null;
}
