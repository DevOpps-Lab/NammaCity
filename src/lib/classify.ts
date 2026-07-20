import type { CategorySource, IssueCategory } from "./types";

/**
 * Category identification, client side.
 *
 * `detect.ts` measures SEVERITY from pixels and refuses to infer CATEGORY,
 * because colour statistics genuinely cannot tell garbage from sandbags. This
 * module asks a vision model instead — and, crucially, is built so that failing
 * to reach it degrades into ASKING the citizen rather than guessing.
 *
 * The three outcomes are deliberately distinct, because they mean different
 * things to the person holding the phone:
 *
 *   identified  — the model answered with usable confidence  -> one tap
 *   uncertain   — the model answered, but hedged             -> confirm, options shown
 *   unavailable — offline, unconfigured, refused, or errored -> they must pick
 */

export interface CategoryGuess {
  category: IssueCategory | null;
  confidence: number;
  reason: string;
  source: CategorySource;
  /** Drives the confirm affordance. See the bands below. */
  state: "identified" | "uncertain" | "unavailable";
  /** Shown verbatim when state is "unavailable" — always a reason, never a shrug. */
  note?: string;
}

/**
 * Confidence bands.
 *
 * IDENTIFIED_FLOOR is where a single tap is allowed. Below UNCERTAIN_FLOOR the
 * category picker is not merely offered but REQUIRED — that lower bound is what
 * keeps a bad classifier safe: at worst the flow degrades to the manual one it
 * replaced, never to a confidently wrong filing.
 */
export const IDENTIFIED_FLOOR = 0.45;
export const UNCERTAIN_FLOOR = 0.25;

const UNAVAILABLE = (note: string): CategoryGuess => ({
  category: null,
  confidence: 0,
  reason: "",
  source: "user",
  state: "unavailable",
  note,
});

export async function classifyCategory(dataUrl: string): Promise<CategoryGuess> {
  let payload: {
    configured?: boolean;
    refused?: boolean;
    error?: string;
    category?: IssueCategory;
    confidence?: number;
    reason?: string;
  };

  try {
    const res = await fetch("/api/classify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl }),
    });
    payload = await res.json();
  } catch {
    return UNAVAILABLE(
      "You appear to be offline, so we couldn't identify this automatically. Pick the category below."
    );
  }

  if (payload.configured === false) {
    return UNAVAILABLE(
      "Automatic identification isn't configured on this deployment. Pick the category below."
    );
  }
  if (payload.refused) {
    return UNAVAILABLE("We couldn't analyse this photo. Pick the category below.");
  }
  if (payload.error || !payload.category) {
    return UNAVAILABLE(
      "Automatic identification didn't work just now. Pick the category below."
    );
  }

  const confidence = payload.confidence ?? 0;

  if (confidence < UNCERTAIN_FLOOR) {
    return {
      category: payload.category,
      confidence,
      reason: payload.reason ?? "",
      source: "model",
      state: "unavailable",
      note: "We couldn't tell what this is with any confidence. Pick the category below.",
    };
  }

  return {
    category: payload.category,
    confidence,
    reason: payload.reason ?? "",
    source: "model",
    state: confidence >= IDENTIFIED_FLOOR ? "identified" : "uncertain",
  };
}
