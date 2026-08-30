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
export const CATEGORY_OPTIONS: { value: IssueCategory; label: string }[] = [
  { value: "pothole", label: "Pothole" },
  { value: "storm_water_drain", label: "Storm water drain" },
  { value: "sewage_overflow", label: "Sewage overflow" },
  { value: "garbage", label: "Garbage" },
  { value: "streetlight", label: "Streetlight" },
  { value: "other", label: "Other" },
];

export function categoryLabel(category: IssueCategory): string {
  return CATEGORY_OPTIONS.find((c) => c.value === category)?.label ?? category;
}
