import type { Report } from "./types";

/**
 * AFTER-PHOTO VERIFICATION — ADVISORY ONLY
 *
 * There is no published method for automatically verifying a civic repair from
 * a follow-up photo; the closest building block is visual place recognition
 * (NetVLAD / Patch-NetVLAD). We compose that with a detector pass.
 *
 * The critical constraint: published pothole detection tops out around
 * 53% mAP@50 — potholes are the WEAKEST class in the standard RDD2022
 * benchmark, because the target is small and under-represented. So when the
 * detector sees nothing in an after-photo, a large fraction of the time that
 * is the model failing, not the road being repaired.
 *
 * Auto-closing on that signal would algorithmically reproduce exactly the fraud
 * this product exists to stop: Chennai has documented complaints closed using
 * photos taken at a different location, and BBMP's Sahaaya closed 1,348
 * complaints for "unknown reasons".
 *
 * Therefore: this module NEVER returns a "closed" verdict. It returns evidence
 * and a recommendation. Only `confirmFixed()`, driven by an explicit human tap,
 * can move a report to `verified_fixed`.
 */

export type VerifyVerdict = "likely_repaired" | "still_present" | "inconclusive";

export interface VerifyResult {
  verdict: VerifyVerdict;
  /** Place-match score from visual place recognition (0-1). */
  placeMatch: number;
  /** Detector confidence that the defect is still present (0-1). */
  defectConfidence: number;
  /** Always false. Present to make the invariant explicit and testable. */
  autoClose: false;
  headline: string;
  reasoning: string[];
}

/** Detector recall ceiling on the pothole class. Drives the honesty warning. */
export const DETECTOR_RECALL = 0.53;

export function evaluateAfterPhoto(
  report: Report,
  signals: { placeMatch: number; defectConfidence: number }
): VerifyResult {
  const { placeMatch, defectConfidence } = signals;
  const reasoning: string[] = [];

  reasoning.push(
    `Visual place match ${(placeMatch * 100).toFixed(0)}%, ${
      placeMatch > 0.8
        ? "same location as the original report"
        : "location match is weak; the after-photo may be from a different spot"
    }.`
  );

  if (placeMatch < 0.6) {
    return {
      verdict: "inconclusive",
      placeMatch,
      defectConfidence,
      autoClose: false,
      headline: "Can't confirm this is the same place",
      reasoning: [
        ...reasoning,
        "Refusing to treat this as evidence of repair. Closing a report on a photo from elsewhere is the documented failure mode we exist to prevent.",
      ],
    };
  }

  if (defectConfidence > 0.45) {
    reasoning.push(
      `Detector still sees the defect (${(defectConfidence * 100).toFixed(0)}%). Not repaired.`
    );
    return {
      verdict: "still_present",
      placeMatch,
      defectConfidence,
      autoClose: false,
      headline: "The defect is still there",
      reasoning,
    };
  }

  // The important branch: absence of detection is evidence, NOT proof.
  reasoning.push(
    `Detector no longer sees the defect (${(defectConfidence * 100).toFixed(0)}%).`
  );
  reasoning.push(
    `But pothole detection recall is only ~${Math.round(DETECTOR_RECALL * 100)}%, a miss looks identical to a repair. This is evidence, not proof.`
  );
  reasoning.push("A citizen must confirm. The system will not close this by itself.");

  return {
    verdict: "likely_repaired",
    placeMatch,
    defectConfidence,
    autoClose: false,
    headline: "Looks repaired, needs your confirmation",
    reasoning,
  };
}

/**
 * Demo scenarios. `missed` is the one to show on stage: the pothole is still
 * physically there, but the detector fails to see it. The system must still
 * refuse to close.
 */
export const VERIFY_SCENARIOS = {
  repaired: { placeMatch: 0.94, defectConfidence: 0.08, label: "Genuinely repaired" },
  missed: { placeMatch: 0.91, defectConfidence: 0.12, label: "Still there, detector missed it" },
  stillThere: { placeMatch: 0.93, defectConfidence: 0.78, label: "Still there, detector caught it" },
  wrongPlace: { placeMatch: 0.31, defectConfidence: 0.05, label: "Photo from a different location" },
} as const;
