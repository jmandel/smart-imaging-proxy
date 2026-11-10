// Who's looking, and whose records: the people and services to pick from, and for the one picked, whose
// studies or which referral.
import type { Cast, Choice, Person, Referral, View } from "./types";

/** The people and services, as two lists. On a phone, one select stands in for both. */
export function WhoList({ cast, view, look }: { cast: Cast; view?: View; look: (c: Choice) => void }) {
  const busy = !!view?.running, current = view?.who.id;
  const chosen = view ? `${view.who.kind === "user" ? "user" : "client"}:${view.who.id}` : "";
  const pick = (value: string) => {
    const at = value.indexOf(":"), kind = value.slice(0, at), id = value.slice(at + 1);
    if (id) look(kind === "user" ? { user: id } : { client: id });
  };
  return (
    <aside className="who" aria-label="Who's looking" id="who">
      <div className="who-select">
        <label>Who's looking
          <select id="who-select" disabled={busy} value={chosen} onChange={e => pick(e.target.value)}>
            {!current && <option value="">Choose someone</option>}
            <optgroup label="People">{cast.people.map(p => <option key={p.id} value={`user:${p.id}`}>{p.name}</option>)}</optgroup>
            <optgroup label="Services">{cast.services.map(s => <option key={s.id} value={`client:${s.id}`}>{s.name}</option>)}</optgroup>
          </select>
        </label>
      </div>
      <section aria-labelledby="h-people"><h2 id="h-people">People</h2>
        <ul>{cast.people.map(p => <li key={p.id}><button type="button" className="person" data-user={p.id} aria-pressed={current === p.id} disabled={busy} onClick={() => look({ user: p.id })}><b>{p.name}</b><span>{p.role}</span></button></li>)}</ul>
      </section>
      <section aria-labelledby="h-services"><h2 id="h-services">Services</h2>
        <ul>{cast.services.map(s => <li key={s.id}><button type="button" className="person" data-client={s.id} aria-pressed={current === s.id} disabled={busy} onClick={() => look({ client: s.id })}><b>{s.name}</b><span>{s.role}</span></button></li>)}</ul>
      </section>
    </aside>
  );
}

/** Whose records, for a person: the ones they hold, and apart from them, others' they don't. */
function Whose({ person, patient, disabled, look }: { person: Person; patient?: string; disabled: boolean; look: (c: Choice) => void }) {
  const held = person.records.map(r => ({ patient: r.patient, label: r.via === "self" ? "Own studies" : `${r.name}'s studies, as ${r.via === "guardian" ? "guardian" : r.relationship}` }));
  const others = person.others;
  if (held.length + others.length < 2) return null;
  const otherChosen = others.some(o => o.patient === patient);
  return (
    <div className="whose">
      {(held.length > 1 || (held.length > 0 && others.length > 0)) && (
        <div className="seg" role="group" aria-label="Whose records">
          {held.map(c => <button key={c.patient} type="button" data-whose={c.patient} aria-pressed={patient === c.patient} disabled={disabled} onClick={() => look({ user: person.id, patient: c.patient })}>{c.label}</button>)}
        </div>
      )}
      {others.length > 0 && (
        <label className="others">Someone else's studies
          <select id="other-records" disabled={disabled} value={otherChosen ? patient : ""} onChange={e => e.target.value && look({ user: person.id, patient: e.target.value })}>
            {!otherChosen && <option value="">Choose a person</option>}
            {others.map(o => <option key={o.patient} value={o.patient}>{o.name}</option>)}
          </select>
        </label>
      )}
    </div>
  );
}

/** The referrals a service works from, grouped by patient. */
function ReferralChoice({ client, referrals, chosen, disabled, look }: { client: string; referrals: Referral[]; chosen?: string; disabled: boolean; look: (c: Choice) => void }) {
  const by = new Map<string, Referral[]>();
  for (const r of referrals) { const k = r.patient ?? "Other"; by.set(k, [...(by.get(k) ?? []), r]); }
  return (
    <div className="whose">
      <label className="others">Referral
        <select id="referral-select" disabled={disabled} value={chosen ?? ""} onChange={e => look({ client, referral: e.target.value })}>
          {[...by].map(([patient, rs]) => <optgroup key={patient} label={patient}>{rs.map(r => <option key={r.id} value={r.id}>{r.report}</option>)}</optgroup>)}
        </select>
      </label>
    </div>
  );
}

/** Whose studies, or which referral, for the one looking. */
export function WhoseChoice({ cast, referrals, view, look }: { cast: Cast; referrals: Referral[]; view: View; look: (c: Choice) => void }) {
  if (view.who.kind === "service") return <ReferralChoice client={view.who.id} referrals={referrals} chosen={view.who.referral} disabled={view.running} look={look} />;
  const person = cast.people.find(p => p.id === view.who.id);
  return person ? <Whose person={person} patient={view.patient} disabled={view.running} look={look} /> : null;
}
