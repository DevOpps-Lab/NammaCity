import type { Authority, IssueCategory } from "./types";

/**
 * AUTHORITY REGISTRY
 *
 * Two hard rules, both derived from research:
 *
 * 1. ROLE ALIASES ONLY. Never a named officer. Municipal engineering cadres
 *    rotate in under two years and department pages carry no `last-updated`
 *    metadata, so a person-addressed contact is stale the moment you scrape it.
 *    Role aliases (seswd@, etc.) survive transfers.
 *
 * 2. NEVER INVENT AN ADDRESS OR AN SLA. Every entry below carries a
 *    `verified` flag and an `slaSource`. Unverified entries are clearly marked
 *    and are NOT presented to the user as real. In this build nothing is sent
 *    to a real government address anyway — see DEMO_SINK.
 */

/** All outbound mail goes here. No unsolicited automated mail to real .gov.in addresses. */
export const DEMO_SINK = process.env.DEMO_INBOX ?? "demo-inbox@civicagent.local";

/**
 * The account public escalations are actually posted from.
 *
 * The same principle as DEMO_SINK, applied to social: the UI must name the
 * account that really posted, not a plausible-looking one. It used to read
 * "@CivicAgent" and "@CivicAgentDemo" — neither of which has ever existed — so
 * the Outbox was showing an audit trail to an account nobody could check.
 *
 * Must match BLUESKY_IDENTIFIER. Declared here rather than read from the
 * environment because the components that display it render on the client.
 */
export const DEMO_SOCIAL_HANDLE = "@nammachennai";

export interface AuthorityRecord extends Authority {
  /** true only where the address was confirmed from a primary source. */
  verified: boolean;
  /** Where the address came from, so staleness is auditable. */
  source: string;
  categories: IssueCategory[];
}

export const CHENNAI_AUTHORITIES: AuthorityRecord[] = [
  {
    id: "gcc-swd",
    name: "GCC — Storm Water Drain Department",
    // Confirmed from chennaicorporation.gov.in/gcc/department/storm-water/
    email: "seswd@chennaicorporation.gov.in",
    verified: true,
    source: "GCC Storm Water Drain department page (primary source)",
    handle: "@chennaicorp",
    slaHours: 72,
    slaSource:
      "GCC public statement: complaints resolved in 2–3 days (reported, DT Next) — not a charter guarantee",
    categories: ["storm_water_drain", "pothole"],
  },
  {
    id: "gcc-roads",
    name: "GCC — Bus Route Roads / Roads Department",
    email: "commissioner@chennaicorporation.gov.in",
    verified: false,
    source: "UNVERIFIED — placeholder pending primary-source confirmation",
    handle: "@chennaicorp",
    slaHours: 72,
    slaSource: "GCC public statement: 2–3 days (reported) — not a charter guarantee",
    categories: ["pothole"],
  },
  {
    id: "cmwssb",
    name: "CMWSSB (Chennai Metro Water) — Area Engineer",
    email: "cmwssb@cmwssb.tn.gov.in",
    verified: false,
    source: "UNVERIFIED — placeholder pending primary-source confirmation",
    handle: "@cmwssbofficial",
    slaHours: 72,
    slaSource: "No published charter SLA located for CMWSSB",
    categories: ["sewage_overflow"],
  },
  {
    id: "gcc-swm",
    name: "GCC — Solid Waste Management",
    email: "commissioner@chennaicorporation.gov.in",
    verified: false,
    source: "UNVERIFIED — placeholder",
    handle: "@chennaicorp",
    slaHours: 24,
    slaSource: "Swachhata app category SLA: 12 hours – 1 week depending on complaint type",
    categories: ["garbage"],
  },
  {
    id: "gcc-streets",
    name: "GCC — Street Lighting Department",
    // BESCOM handles lighting outside Chennai city limits; inside GCC handles it.
    email: "commissioner@chennaicorporation.gov.in",
    verified: false,
    source: "UNVERIFIED — placeholder pending primary-source confirmation",
    handle: "@chennaicorp",
    slaHours: 48,
    slaSource: "Citizen Charter target: 2 working days for streetlight faults",
    categories: ["streetlight"],
  },
  {
    id: "gcc-general",
    name: "GCC — Commissioner's Office (General Complaints)",
    email: "commissioner@chennaicorporation.gov.in",
    verified: false,
    source: "UNVERIFIED — catch-all for complaints not matching a known department",
    handle: "@chennaicorp",
    slaHours: 72,
    slaSource: "Default 72h — no specific charter SLA for this category",
    categories: ["other"],
  },
];

/**
 * THE JURISDICTION SPLIT — and why we often refuse to pick one.
 *
 * On paper Chennai is clean: the CMWSSB Act expressly EXCLUDES "a rain or storm
 * water drain ... exclusively meant to drain away rain water on the road", so
 * storm water -> GCC and sewage -> CMWSSB.
 *
 * In practice it fails constantly — sewage flows into storm water drains, and
 * the Madras HC has had to order BOTH bodies to file counters over an SWD built
 * atop a sewage channel in Ambattur.
 *
 * So for anything drainage-shaped we file to BOTH. Bombay HC (High Court on its
 * own motion v. State of Maharashtra, 13 Oct 2025) refuses to let agencies
 * create "no-man's zones" of responsibility: where they dispute who owns a
 * defect, they are ordered to pay equally. Filing wide is the judicially
 * endorsed move, not a cop-out.
 */
export const AMBIGUOUS_CATEGORIES: IssueCategory[] = [
  "storm_water_drain",
  "sewage_overflow",
];

export function authoritiesFor(
  category: IssueCategory
): { authorities: AuthorityRecord[]; ambiguityNote?: string } {
  const matches = CHENNAI_AUTHORITIES.filter((a) => a.categories.includes(category));

  if (AMBIGUOUS_CATEGORIES.includes(category)) {
    const both = CHENNAI_AUTHORITIES.filter(
      (a) => a.id === "gcc-swd" || a.id === "cmwssb"
    );
    return {
      authorities: both,
      ambiguityNote:
        "Storm-water vs sewer ownership is ambiguous here. Filing to GCC and CMWSSB simultaneously rather than guessing — Bombay HC (13 Oct 2025) forbids agencies creating 'no-man's zones' of responsibility.",
    };
  }

  if (matches.length > 1) {
    return {
      authorities: matches,
      ambiguityNote: `${matches.length} agencies plausibly responsible. Filing to all rather than guessing.`,
    };
  }

  return { authorities: matches };
}

/**
 * TIER 4 — the last resort, when no verified registry covers a location and the
 * LLM fallback could not answer either.
 *
 * Refusing outright would lock out every citizen outside the ~28 Indian urban
 * local bodies with open ward polygons, which is most of the country. So we file
 * to a general municipal office, clearly marked UNVERIFIED: honest about the
 * uncertainty without denying the citizen a filing. The real send target is the
 * sandbox mailbox regardless, so this never mails a stranger.
 *
 * Was hardcoded inline in `pipeline.ts`; it lives here now because both the
 * browser and the WhatsApp webhook resolve through one shared chain.
 */
export function genericMunicipalAuthority(
  cityName: string | undefined,
  category: IssueCategory
): AuthorityRecord {
  return {
    id: "fallback-municipal",
    name: cityName
      ? `${cityName} — Municipal Body (General Complaints)`
      : "Local Municipal Body (General Complaints)",
    email: "commissioner@localbody.gov.in",
    verified: false,
    source: "Deterministic fallback — no verified registry covers this location",
    slaHours: 72,
    slaSource: "Default 72h — no published charter located for this location",
    categories: [category],
  };
}

/**
 * Documented SLAs from other jurisdictions, shown for context in the UI.
 * We always cite the authority's OWN published deadline rather than inventing one —
 * "you missed your own 48-hour commitment" is rhetorically and legally far
 * stronger than "our model estimated 7 days".
 */
export const REFERENCE_SLAS = [
  {
    body: "Bombay High Court (13 Oct 2025)",
    hours: 48,
    note: "Judicially mandated pothole repair in Maharashtra. Right to safe roads held to be an Article 21 fundamental right.",
    enforceable: true,
  },
  {
    body: "GHMC Citizen's Charter (Hyderabad)",
    hours: 24,
    note: "Charter commitment to fill potholes within 24 hours of complaint.",
    enforceable: false,
  },
  {
    body: "CPGRAMS (central)",
    hours: 21 * 24,
    note: "21-day disposal mandate. Average 13–15 days central; 64 days for States/UTs.",
    enforceable: false,
  },
];
