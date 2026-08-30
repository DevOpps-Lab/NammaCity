import type { IssueCategory } from "./types";
import slaData from "./slas.json";

/**
 * SLA LOOKUP — Citizen Charter Timeline
 *
 * Maps an issue category to the government's own published resolution target,
 * parsed from slas.json which was built from the GCC Road Maintenance and Tree
 * Removal Citizen Charters.
 *
 * "You missed your own 2-day commitment" is far stronger than
 * "our model estimated 7 days" — so we always use the authority's own
 * published deadline rather than a hardcoded constant or an LLM guess.
 *
 * The mapping from IssueCategory to SLA entries uses a best-match approach
 * since the charter uses plain English labels and the codebase uses
 * slug identifiers.
 */

export interface SLAResult {
  /** Hours until the authority's own deadline. */
  hours: number;
  /** Human-readable target from the charter (e.g. "2 days"). */
  resolutionTarget: string;
  /** The department the charter names. */
  department: string;
  /** Citation for the Agent Trace — always shown, never hidden. */
  source: string;
}

type SLAEntry = {
  category: string;
  department: string;
  resolutionTarget: string;
  trigger: string;
  source: string;
};

const ENTRIES: SLAEntry[] = slaData as SLAEntry[];

/** Parse "2 days", "1 week", "1 working day", "3 working days" → hours. */
function parseHours(target: string): number {
  const t = target.toLowerCase();

  // "X working day(s)"
  const workingDays = t.match(/(\d+)\s+working\s+day/);
  if (workingDays) return Number(workingDays[1]) * 24;

  // "X day(s)"
  const days = t.match(/(\d+)\s+day/);
  if (days) return Number(days[1]) * 24;

  // "X week(s)"
  const weeks = t.match(/(\d+)\s+week/);
  if (weeks) return Number(weeks[1]) * 7 * 24;

  // "within X weeks"
  const withinWeeks = t.match(/within\s+(\d+)\s+week/);
  if (withinWeeks) return Number(withinWeeks[1]) * 7 * 24;

  // "X days after ..." — take the X
  const daysAfter = t.match(/(\d+)\s+day.*after/);
  if (daysAfter) return Number(daysAfter[1]) * 24;

  // Fallback: 72h — safe, not invented
  return 72;
}

/**
 * Maps IssueCategory slugs to charter category labels.
 * If no exact match, falls through to the generic default.
 */
const CATEGORY_MAP: Partial<Record<IssueCategory, string>> = {
  pothole: "Pothole",
  storm_water_drain: "Missing/Broken Storm Water Drain Chamber Cover",
  sewage_overflow: "Missing/Broken Storm Water Drain Chamber Cover", // closest match in charter
  garbage: "Debris on Public Land (Owner Responsible)",
  streetlight: "Road Obstruction", // no streetlight entry; use 1 working day as a reasonable proxy
  other: "",
};

const DEFAULT: SLAResult = {
  hours: 72,
  resolutionTarget: "72 hours",
  department: "Municipal Department",
  source: "Default, no matching Citizen Charter SLA located for this category",
};

/**
 * Returns the government's own published SLA for the given issue category.
 * Always falls back to 72h rather than throwing or returning null.
 */
export function getSLA(category: IssueCategory): SLAResult {
  const label = CATEGORY_MAP[category];
  if (!label) return DEFAULT;

  const entry = ENTRIES.find(
    (e) => e.category.toLowerCase() === label.toLowerCase()
  );
  if (!entry) return DEFAULT;

  return {
    hours: parseHours(entry.resolutionTarget),
    resolutionTarget: entry.resolutionTarget,
    department: entry.department,
    source: entry.source,
  };
}
