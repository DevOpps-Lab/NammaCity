import type { IssueCategory } from "./types";
import type { LLMSeverity } from "@/app/api/analyze-image/route";

/**
 * LLM IMAGE ANALYSER — client-side wrapper
 *
 * Calls /api/analyze-image and normalises the response into a shape that
 * ReportTab.tsx can consume directly. Replaces the two separate calls to
 * classifyCategory() + analyseImage() with a single round trip.
 *
 * Three distinct states mirror the existing classify.ts pattern so the UI
 * component can be updated minimally:
 *
 *   identified  — confidence ≥ 0.45, one-tap path allowed
 *   uncertain   — confidence 0.25-0.45, picker shown but pre-filled
 *   unavailable — offline / unconfigured / refused / too low
 */

export interface LLMAnalysisResult {
  category: IssueCategory | null;
  /** minor | moderate | severe — what the LLM guessed. User overrides this. */
  severity: LLMSeverity | null;
  confidence: number;
  reason: string;
  state: "identified" | "uncertain" | "unavailable";
  /** Shown verbatim in the UI when state is "unavailable". */
  note?: string;
}

export const IDENTIFIED_FLOOR = 0.45;
export const UNCERTAIN_FLOOR = 0.25;

const UNAVAILABLE = (note: string): LLMAnalysisResult => ({
  category: null,
  severity: null,
  confidence: 0,
  reason: "",
  state: "unavailable",
  note,
});

export async function llmAnalyze(dataUrl: string): Promise<LLMAnalysisResult> {
  let payload: {
    configured?: boolean;
    refused?: boolean;
    rateLimited?: boolean;
    error?: string;
    category?: IssueCategory;
    severity?: LLMSeverity;
    confidence?: number;
    reason?: string;
  };

  try {
    const res = await fetch("/api/analyze-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl }),
      // A Vercel function runs for up to 300s, so a stalled Gemini call would
      // leave the Report tab spinning for five minutes with no way out. The
      // catch below already degrades to "choose the category yourself"; this
      // just makes sure we actually reach it.
      signal: AbortSignal.timeout(30_000),
    });
    payload = await res.json();
  } catch {
    return UNAVAILABLE(
      "You appear to be offline — automatic analysis is unavailable. Choose the category and severity below."
    );
  }

  if (payload.configured === false) {
    return UNAVAILABLE(
      "Automatic analysis isn't configured on this deployment. Choose the category and severity below."
    );
  }
  if (payload.refused) {
    return UNAVAILABLE("We couldn't analyse this photo. Choose the category and severity below.");
  }
  if (payload.rateLimited) {
    return UNAVAILABLE(
      "Automatic analysis has hit today's free-tier limit (Gemini allows ~20/day). Choose the category and severity below — filing works exactly the same."
    );
  }
  if (payload.error || !payload.category) {
    return UNAVAILABLE(
      "Automatic analysis didn't work just now. Choose the category and severity below."
    );
  }

  const confidence = payload.confidence ?? 0;

  if (confidence < UNCERTAIN_FLOOR) {
    return {
      category: payload.category ?? null,
      severity: payload.severity ?? null,
      confidence,
      reason: payload.reason ?? "",
      state: "unavailable",
      note: "We couldn't determine the issue type with confidence. Choose the category and severity below.",
    };
  }

  return {
    category: payload.category,
    severity: payload.severity ?? "moderate",
    confidence,
    reason: payload.reason ?? "",
    state: confidence >= IDENTIFIED_FLOOR ? "identified" : "uncertain",
  };
}
