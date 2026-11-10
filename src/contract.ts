// A sandbox's ground truth as data: its sample people and kinds of client, and what a correct app sees
// for each person and patient, worked out by the reference model from the sandbox's policy as it stands. llms.txt's
// table of expected answers is drawn from this, and a test checks every answer here against real searches, so the
// prose, the data and the behaviour can't disagree.
import { PATIENT_NAMES, USERS } from "./auth-server";
import { modelOf, refStudies } from "./tours";
import { reportTitle } from "./referrals";
import type { Faults, Sandbox } from "./sandbox";

export interface ExpectedView {
  user: string; patient: string; via: "self" | "related";
  /** What an app sees, signed in as `user` for `patient` and approving everything offered: its search's `total`. */
  studies: { id: string; uid: string; title: string }[];
  /** A report for each study it sees, and none for a study withheld. */
  reports: number;
  /** The patient's studies the app doesn't see, and the labels that keep them out. */
  withheld: { id: string; title: string; labels: string[] }[];
}
export interface Contract {
  about: string;
  users: { username: string; name: string; fhirUser: string; patient?: string }[];
  patients: { id: string; name: string; studies: number }[];
  clientTypes: { type: "public" | "confidential" | "backend"; auth: string; grant: string; scope: string }[];
  /** What's set on the sandbox now, so whether it answers as a new one is a question with no token. */
  state: {
    /** No fault set, no app check running, and the demo clock where it started. */
    clean: boolean;
    faults: Faults;
    clockOffsetSeconds: number;
    /** A running app check's script and what it stages, not its run's id, which is the access to the run. */
    appCheck: { script: string; staged: string[]; endsAt: string } | null;
  };
  /** Every person and patient pairing a person can act on, as this sandbox's policy stands now. */
  expected: ExpectedView[];
}

export function contractOf(sandbox: Sandbox): Contract {
  const model = modelOf(sandbox), all = refStudies(sandbox), catalog = sandbox.catalog.allStudies();
  const info = (id: string) => { const st = catalog.find(c => c.id === id)!; return { id, uid: st.uid, title: reportTitle(st) }; };
  const expected: ExpectedView[] = [];
  for (const [user, u] of Object.entries(USERS)) for (const patient of Object.keys(PATIENT_NAMES)) {
    const self = u.patient === patient;
    if (!self && !model.holds(user, patient)) continue;
    const seen = new Set(model.userReach(user, patient).map(s => s.id)), theirs = all.filter(s => s.patient === patient);
    expected.push({
      user, patient, via: self ? "self" : "related",
      studies: theirs.filter(s => seen.has(s.id)).map(s => info(s.id)),
      reports: theirs.filter(s => seen.has(s.id)).length,
      withheld: theirs.filter(s => !seen.has(s.id)).map(s => { const { uid: _u, ...rest } = info(s.id); return { ...rest, labels: s.labels ?? [] }; }),
    });
  }
  return {
    about: "This sandbox's ground truth, as data: what llms.txt describes in prose. `expected` is worked out from the sandbox's policy now, so it changes when the policy does; a new sandbox's is the default.",
    users: Object.entries(USERS).map(([username, u]) => ({ username, name: u.name, fhirUser: u.fhirUser, ...(u.patient ? { patient: u.patient } : {}) })),
    patients: Object.entries(PATIENT_NAMES).map(([id, name]) => ({ id, name, studies: all.filter(s => s.patient === id).length })),
    clientTypes: [
      { type: "public", auth: "none, with PKCE S256", grant: "authorization_code", scope: "launch/patient patient/*.rs" },
      { type: "confidential", auth: "private_key_jwt, ES256, ES384 or RS384", grant: "authorization_code", scope: "launch/patient patient/*.rs" },
      { type: "backend", auth: "private_key_jwt, ES256, ES384 or RS384", grant: "client_credentials", scope: "system/ImagingStudy.rs" },
    ],
    state: stateOf(sandbox),
    expected,
  };
}

function stateOf(sandbox: Sandbox): Contract["state"] {
  const faults = sandbox.faults(), offset = sandbox.clock.offset(), run = sandbox.appCheck;
  const faulty = faults.decisionOutage || faults.endpointForms || [faults.truncateAfter, faults.pageSize, faults.searchRetryAfter, faults.retrievalRetryAfter].some(x => x !== null);
  return { clean: !faulty && !run && offset === 0, faults, clockOffsetSeconds: offset, appCheck: run ? { script: run.script, staged: run.staged, endsAt: run.endsAt } : null };
}

/** llms.txt's table of expected answers, from the contract. */
export function expectedTable(c: Contract): string {
  const rows = c.expected.map(v => {
    const name = c.patients.find(p => p.id === v.patient)!.name.split(" ")[0];
    const seen = v.studies.length ? `${v.studies.length}${v.withheld.length ? ` of ${name}'s ${v.studies.length + v.withheld.length}` : ""}` : "None: `total` 0, no entries";
    const why = v.withheld.length ? `Left out: ${v.withheld.map(w => `${w.title}, labeled ${w.labels.join(", ") || "nothing"}`).join("; ")}. Its report reads as 404 too` : v.studies.length ? (v.via === "self" ? "The patient's own" : "Shared with them") : "No studies on file. Exit cleanly, not with an error";
    return `| \`${v.user}\` | \`${v.patient}\` | ${seen} | ${v.reports ? `${v.reports}` : "None"} | ${why} |`;
  });
  return ["| Sign in as | Choose | `ImagingStudy?patient=` | `DiagnosticReport?patient=` | Why |", "|---|---|---|---|---|", ...rows].join("\n");
}
