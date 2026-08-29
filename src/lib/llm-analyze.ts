import type { IssueCategory } from "./types";
import type { LLMSeverity } from "@/app/api/analyze-image/route";
import type { BlurRegion } from "./imaging";
import type { FaceBox } from "./vision";

/**
 * LLM IMAGE ANALYSER — client-side wrapper
 *
 * Calls /api/analyze-image and normalises the response into a shape that
 * ReportTab.tsx can consume directly. One round trip returns category, severity
 * AND the face / number-plate boxes to redact — there is no on-device detector
 * any more, so this call IS the detection step.
 *
 * Three category states (unchanged):
 *   identified  — confidence ≥ 0.45, one-tap path allowed
 *   uncertain   — confidence 0.25-0.45, picker shown but pre-filled
 *   unavailable — offline / unconfigured / refused / too low
 *
 * `detection.ran` is separate: it is true whenever the call actually reached
 * Gemini and got boxes back, EVEN IF the category came back low-confidence. A
 * low-confidence category is not a detection failure. When `ran` is false the
 * caller must make the user redact manually before filing.
 */

export interface RedactDetection {
  faces: BlurRegion[];
  plates: BlurRegion[];
  ran: boolean;
}

export interface LLMAnalysisResult {
  category: IssueCategory | null;
  /** minor | moderate | severe — what the LLM guessed. User overrides this. */
  severity: LLMSeverity | null;
  confidence: number;
  reason: string;
  state: "identified" | "uncertain" | "unavailable";
  /** Shown verbatim in the UI when state is "unavailable". */
  note?: string;
  /** Face + plate boxes (frame pixels) and whether detection actually ran. */
  detection: RedactDetection;
}

export const IDENTIFIED_FLOOR = 0.45;
export const UNCERTAIN_FLOOR = 0.25;

const NO_DETECTION: RedactDetection = { faces: [], plates: [], ran: false };

const UNAVAILABLE = (note: string): LLMAnalysisResult => ({
  category: null,
  severity: null,
  confidence: 0,
  reason: "",
  state: "unavailable",
  note,
  detection: NO_DETECTION,
});

/** Gemini's 0-1000 boxes → pixel BlurRegions for `frameW`×`frameH`. */
function toRegions(boxes: FaceBox[] | undefined, frameW: number, frameH: number): BlurRegion[] {
  if (!Array.isArray(boxes)) return [];
  return boxes.map((b) => ({
    x: (Math.min(b.xmin, b.xmax) / 1000) * frameW,
    y: (Math.min(b.ymin, b.ymax) / 1000) * frameH,
    w: (Math.abs(b.xmax - b.xmin) / 1000) * frameW,
    h: (Math.abs(b.ymax - b.ymin) / 1000) * frameH,
  }));
}

export async function llmAnalyze(
  dataUrl: string,
  frameW: number,
  frameH: number
): Promise<LLMAnalysisResult> {
  let payload: {
    configured?: boolean;
    refused?: boolean;
    rateLimited?: boolean;
    error?: string;
    category?: IssueCategory;
    severity?: LLMSeverity;
    confidence?: number;
    reason?: string;
    faces?: FaceBox[];
    plates?: FaceBox[];
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
      "Automatic analysis has hit today's free-tier limit. Choose the category and severity below — filing works exactly the same."
    );
  }
  if (payload.error || !payload.category) {
    return UNAVAILABLE(
      "Automatic analysis didn't work just now. Choose the category and severity below."
    );
  }

  // The call reached Gemini and returned — detection is valid from here on, even
  // if the category confidence is low.
  const detection: RedactDetection = {
    faces: toRegions(payload.faces, frameW, frameH),
    plates: toRegions(payload.plates, frameW, frameH),
    ran: true,
  };

  const confidence = payload.confidence ?? 0;

  if (confidence < UNCERTAIN_FLOOR) {
    return {
      category: payload.category ?? null,
      severity: payload.severity ?? null,
      confidence,
      reason: payload.reason ?? "",
      state: "unavailable",
      note: "We couldn't determine the issue type with confidence. Choose the category and severity below.",
      detection,
    };
  }

  return {
    category: payload.category,
    severity: payload.severity ?? "moderate",
    confidence,
    reason: payload.reason ?? "",
    state: confidence >= IDENTIFIED_FLOOR ? "identified" : "uncertain",
    detection,
  };
}
