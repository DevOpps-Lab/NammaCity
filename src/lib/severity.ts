import type { Severity } from "./types";
import type { LLMSeverity } from "@/app/api/analyze-image/route";

/**
 * The vision model answers in `minor | moderate | severe`; the database check
 * constraint on `reports.severity` accepts `small | medium | large`. Two
 * vocabularies for one idea, so the translation has to live somewhere.
 *
 * It lives here because it now has two callers — ReportTab (where it started,
 * inline) and the WhatsApp webhook. Duplicating it would mean a wrong copy
 * fails as a Postgres check-constraint violation at insert time, which is a
 * miserable way to find a typo.
 */
export const SEVERITY_OPTIONS: {
  value: LLMSeverity;
  label: string;
  mapped: Severity;
}[] = [
  { value: "minor", label: "Minor", mapped: "small" },
  { value: "moderate", label: "Moderate", mapped: "medium" },
  { value: "severe", label: "Severe", mapped: "large" },
];

/** Falls back to the middle bucket, which is also the vision route's default. */
export function toSeverity(llm: LLMSeverity | null | undefined): Severity {
  return SEVERITY_OPTIONS.find((s) => s.value === llm)?.mapped ?? "medium";
}
