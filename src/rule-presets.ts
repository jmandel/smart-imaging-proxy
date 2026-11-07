// The named rule sets the admin screen offers: sets of service-access policies, and the only ones it
// can apply. Each set follows the pattern of a flow. Anything a set needs from the catalog, such as a
// series UID, is read when it's applied.
import type { CatalogStore, ServiceAccessPolicy } from "@smart-imaging-proxy/core";

type Rule = ServiceAccessPolicy;

const PATIENT = "josh-example";
const CT = "ct-abdomen-pelvis-2012";
const WITHHELD_SERIES = /Clinical Documents|Dose (Report|Record)/;

/** A service-access policy for one of the demo's backend clients and Josh. */
export const serviceAccess = (id: string, client: string, description: string, rest: Pick<Rule, "allow"> & Partial<Rule>): Rule => ({ id, type: "service-access", description, service: `service:${client}`, patients: `patient:${PATIENT}`, ...rest });
const handWristReferral = serviceAccess("hand-referral", "hand-referral-service", "Referral service: hand and wrist X-rays", { allow: { modalities: ["CR"] } });
const researchDonation = serviceAccess("research-consent", "research-donation", "Josh's research donation consent", { allow: { all: true } });

/** The CT with three series withheld, or nothing if this catalog doesn't hold the study or those series. */
function outsideRelease(catalog: CatalogStore): Rule | undefined {
  const study = catalog.allStudies().find(s => s.id === CT);
  if (!study) return undefined;
  const series = catalog.hierarchies([study.pk]).get(study.pk)?.series ?? [];
  const withhold = series.filter(s => WITHHELD_SERIES.test(s.description ?? "")).map(s => s.uid);
  if (!withhold.length) return undefined;
  return serviceAccess("outside-release", "outside-release-service", "Outside release: CT without its dose report, dose record and clinical documents", { allow: { studies: [CT] }, withholdSeries: withhold });
}

export interface RuleSet {
  id: string;
  label: string;
  description: string;
  /** The rules for this catalog, or undefined if it lacks what they name. */
  rules(catalog: CatalogStore): Rule[] | undefined;
}

export const RULE_SETS: RuleSet[] = [
  {
    id: "no-extra-rules", label: "No extra rules",
    description: "No client is pre-authorized, so a backend client gets a 403. A signed-in person's app sees what that person allowed.",
    rules: () => [],
  },
  {
    id: "hand-wrist-referral", label: "Referral service: hand and wrist X-rays",
    description: "The hand surgery referral service can see Josh Example's X-ray (CR) studies, which are his hand and wrist films, and nothing else of his.",
    rules: () => [handWristReferral],
  },
  {
    id: "outside-release", label: "Outside release: CT with series withheld",
    description: "The outside release service can see Josh Example's abdomen and pelvis CT, without its Dose Report, Dose Record and Clinical Documents series. It sees nothing else of his.",
    rules: catalog => { const rule = outsideRelease(catalog); return rule && [rule]; },
  },
  {
    id: "research-donation", label: "Research donation",
    description: "The research donation service can see all of Josh Example's studies, as his consent allows.",
    rules: () => [researchDonation],
  },
  {
    id: "all-three-services", label: "All three services",
    description: "The referral, outside release and research donation services each get the access their own rule set gives them.",
    rules: catalog => { const rule = outsideRelease(catalog); return rule && [handWristReferral, rule, researchDonation]; },
  },
];

export const ruleSetById = (id: unknown) => RULE_SETS.find(s => s.id === id);

/** The same rule, whatever order its fields are in. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canonical(x)]));
  return v;
}
const same = (a: Rule[], b: Rule[]) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** The named set these rules are, under any of these catalogs. Rules that came from elsewhere match none. */
export function matchRuleSet(rules: Rule[], catalogs: CatalogStore[]): RuleSet | undefined {
  return RULE_SETS.find(set => catalogs.some(catalog => { const mine = set.rules(catalog); return !!mine && same(mine, rules); }));
}

/** The narrowest named set that pre-authorizes this client for this patient. */
export function ruleSetFor(client: string, patient: string, catalog: CatalogStore): RuleSet | undefined {
  return RULE_SETS.find(set => set.rules(catalog)?.some(r => r.service === `service:${client}` && r.patients === `patient:${patient}`));
}
