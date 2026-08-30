import type { ReportStatus } from "./types";

/**
 * STATUS VISUAL LANGUAGE
 *
 * The load-bearing distinction is `claims_done` vs `verified_fixed`:
 *   claims_done    -> hollow, dashed, muted    ("they say it's done")
 *   verified_fixed -> solid, bright            ("a citizen confirmed it")
 *
 * Indian civic apps report 93–95% resolution because the accused department
 * closes its own ticket; independently-measured FixMyStreet reports ~34%.
 * Rendering "claimed" and "verified" identically is precisely the lie this
 * product exists to refuse, so it must be visible at a glance on the map.
 *
 * COLOUR TUNING: these are 600/700-level, not the 400/500-level values a dark
 * basemap wants. A pale basemap washes out light pastels — `acknowledged` and
 * `transferred` in particular were near-invisible against Positron tiles.
 * `past_sla` (#dc2626) and `escalated` (#991b1b) were also only one step apart
 * before; they are now separable at pin size.
 *
 * claims_done vs verified_fixed is separated on LIGHTNESS, not hue. Darkening
 * every colour uniformly for contrast pushed both into the same dark green and
 * quietly erased the product's central distinction. So claimed goes lighter and
 * greyer (recessive, ~2.6:1 — it is a claim, it should not shout) while
 * verified goes dark and saturated (assertive, 4.5:1). Sage-vs-green is also
 * close to a worst case under deuteranopia, so hue alone was never load-bearing:
 * the real signal is dashed-hollow vs solid, reinforced by the label text
 * "Claimed fixed — unverified", which must never be truncated to "Claimed" for
 * layout convenience.
 */

export interface StatusStyle {
  label: string;
  /** Compact form for dense lists, where the full label would wrap. */
  short?: string;
  color: string;
  /** hollow = dashed outline, no fill: a claim, not a confirmation */
  hollow: boolean;
  pulse: boolean;
  description: string;
}

export const STATUS_STYLES: Record<ReportStatus, StatusStyle> = {
  reported: {
    label: "Reported",
    color: "#e0913c",
    hollow: false,
    pulse: true,
    description: "Just submitted, being triaged",
  },
  filed: {
    label: "Filed",
    color: "#5b9cf0",
    hollow: false,
    pulse: false,
    description: "Complaint dispatched to the responsible agencies",
  },
  acknowledged: {
    label: "Acknowledged",
    color: "#3fb6d8",
    hollow: false,
    pulse: false,
    description: "Authority has acknowledged receipt",
  },
  transferred: {
    label: "Transferred",
    color: "#a78bfa",
    hollow: false,
    pulse: false,
    description: "Agency claimed it belongs to someone else. Re-filed, clock not reset.",
  },
  past_sla: {
    label: "Past SLA",
    color: "#e85f52",
    hollow: false,
    pulse: true,
    description: "The authority has missed its own published deadline",
  },
  escalated: {
    label: "Escalated",
    color: "#f0724f",
    hollow: false,
    pulse: true,
    description: "Published to the public accountability ledger",
  },
  claims_done: {
    label: "Claimed fixed, unverified",
    short: "Claimed fixed",
    color: "#9aa8a0",
    hollow: true,
    pulse: false,
    description: "The authority says this is resolved. No citizen has confirmed it. NOT closed.",
  },
  verified_fixed: {
    label: "Verified fixed",
    color: "#4fae7c",
    hollow: false,
    pulse: false,
    description: "A citizen confirmed the repair with an after-photo. Closed.",
  },
};

export const OPEN_STATUSES: ReportStatus[] = [
  "reported",
  "filed",
  "acknowledged",
  "transferred",
  "past_sla",
  "escalated",
  "claims_done",
];

export function isOpen(s: ReportStatus) {
  return OPEN_STATUSES.includes(s);
}

export function isBreached(s: ReportStatus) {
  return s === "past_sla" || s === "escalated";
}
