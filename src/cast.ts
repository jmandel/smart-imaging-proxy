// Who's who in the demo: each person, app, service and the organization, in one line that says why
// they're here. The home page lists them, and Explore says the same of whoever is chosen.

/** People, by account id. */
export const PEOPLE_LINES: Record<string, string> = {
  josh: "A patient with studies at three imaging sites. His are the real, de-identified images in this demo.",
  "sam-caregiver": "Riley's parent and guardian, and a patient too. Josh can share his studies with Sam.",
  "alex-neighbor": "Josh's neighbor, with no records of Alex's own, who sees only what someone shares.",
  robin: "A patient with no studies, so a search for Robin finds nothing.",
};
/** Riley has no account, and appears only through Sam. */
export const RILEY_LINE = "Sam's child, aged 15, with no account. Sam sees Riley's studies as Riley's guardian.";
/** Services, by client id. */
export const SERVICE_LINES: Record<string, string> = {
  "hand-referral-service": "Reads referrals to a hand surgeon, and fetches the X-ray a referral cites.",
  "outside-release-service": "Sends one of Josh's CT scans to an outside clinic, without its dose reports.",
  "research-donation": "Receives the studies Josh agreed to donate to research.",
};
export const APP_LINE = "The app people sign in to, to see studies. Each person decides what it may see.";
export const NETWORK_LINE = "The organization that runs the imaging sites and sets the rules: who guardians can see at each age, who can share, and what each service can see.";
