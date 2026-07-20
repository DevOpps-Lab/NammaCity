/**
 * Single source of truth for the category set. Exported as a value (not just a
 * type) because the classifier's JSON schema and the DB CHECK constraint both
 * need the list at runtime — three hand-maintained copies would drift.
 */
export const CATEGORY_VALUES = [
  "pothole",
  "storm_water_drain",
  "sewage_overflow",
  "garbage",
  "streetlight",
  "other",
] as const;

export type IssueCategory = (typeof CATEGORY_VALUES)[number];

/** How the category on a report was arrived at. Surfaced to the authority. */
export type CategorySource = "model" | "heuristic" | "user";

export type Severity = "small" | "medium" | "large";

/**
 * Lifecycle states. Note the deliberate split between `claims_done` and
 * `verified_fixed`: an authority may CLAIM a repair, but only a citizen
 * confirming an after-photo can CLOSE it. That distinction is the product.
 */
export type ReportStatus =
  | "reported"
  | "filed"
  | "acknowledged"
  | "transferred"
  | "past_sla"
  | "escalated"
  | "claims_done"
  | "verified_fixed";

export type RoutingTier = 1 | 2 | 3 | 4;
export type Confidence = "high" | "medium" | "low" | "unresolved";

export interface Authority {
  id: string;
  name: string;
  /** Role-based alias ONLY. Never a named individual — officers rotate in <2 years. */
  email: string;
  /** Public handle for escalation. Institution, never a person. */
  handle?: string;
  /** SLA in hours. */
  slaHours: number;
  /** Where the SLA comes from. Always shown in the UI — we never invent a deadline. */
  slaSource: string;
}

export interface RoutingResult {
  tier: RoutingTier;
  confidence: Confidence;
  /** Human-readable description of how this was resolved, for the Agent Trace. */
  method: string;
  ward?: number;
  zoneName?: string;
  zoneNo?: string;
  cityName?: string;
  lgdCode?: string;
  /**
   * All plausibly-responsible agencies. When jurisdiction is ambiguous we do NOT
   * guess — we file against every candidate. Bombay HC (13 Oct 2025) forbids
   * agencies creating "no-man's zones" of responsibility.
   */
  authorities: Authority[];
  /** Set when we deliberately filed wide rather than picking one owner. */
  ambiguityNote?: string;
}

export interface Report {
  id: string;
  /**
   * The citizen who filed it. Since the map became community-readable, a report
   * in the store is not necessarily yours — and only the owner may verify,
   * escalate or close one. The UI reads this to decide which actions to offer;
   * RLS enforces it regardless of what the UI does.
   */
  ownerId?: string;
  lat: number;
  lng: number;
  /** Human-readable location label for the feed. */
  place: string;
  category: IssueCategory;
  /**
   * How the category was arrived at. Carried into the complaint body: an
   * authority receiving an auto-classified report is entitled to know that,
   * and to know a human confirmed it.
   */
  categorySource: CategorySource;
  categoryConfidence: number;
  severity: Severity;
  /** Detector confidence 0-1. Ordinal severity only — never a depth in cm. */
  detectionConfidence: number;
  photoUrl: string;
  afterPhotoUrl?: string;
  /** Perceptual hash of the redacted photo, used to confirm duplicates. */
  aHash?: string;
  status: ReportStatus;
  routing: RoutingResult;
  /** ms epoch */
  createdAt: number;
  slaDeadline: number;
  filedTo: string[];
  supporters: number;
  escalationPostId?: string;
  timeline: TimelineEvent[];
}

export interface TimelineEvent {
  at: number;
  kind: string;
  detail: string;
}

export interface TraceLine {
  agent: "TRIAGE" | "ROUTING" | "AUTHORITY" | "SLA" | "FILING" | "GUARD";
  text: string;
  status?: "ok" | "warn" | "info";
  ms?: number;
}
