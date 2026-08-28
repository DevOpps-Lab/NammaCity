import type { IssueCategory } from "./types";

/**
 * The category list with its display labels, in one server-safe place.
 *
 * This used to live in `detect.ts`, which is `"use client"` — fine while only
 * the UI needed it, but the WhatsApp webhook has to name a category in a reply
 * and a server module must not import a client one. `detect.ts` re-exports this
 * so existing imports keep working.
 *
 * Category still comes from the user or the vision model — inferring it from
 * pixels alone is not credible.
 */
export const CATEGORY_OPTIONS: { value: IssueCategory; label: string; ta: string }[] = [
  { value: "pothole", label: "Pothole", ta: "சாலைக் குழி" },
  { value: "storm_water_drain", label: "Storm water drain", ta: "மழைநீர் வடிகால்" },
  { value: "sewage_overflow", label: "Sewage overflow", ta: "கழிவுநீர் வழிதல்" },
  { value: "garbage", label: "Garbage", ta: "குப்பை" },
  { value: "streetlight", label: "Streetlight", ta: "தெருவிளக்கு" },
  { value: "other", label: "Other", ta: "மற்றவை" },
];

export function categoryLabel(category: IssueCategory): string {
  return CATEGORY_OPTIONS.find((c) => c.value === category)?.label ?? category;
}
