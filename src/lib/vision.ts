import { CATEGORY_VALUES, type IssueCategory } from "./types";
import { parseLoosely } from "./json-loose";

/**
 * GEMINI VISION — the one implementation.
 *
 * This was inline in `/api/analyze-image/route.ts`, which was fine while the
 * browser was the only caller. The WhatsApp webhook needs the same analysis
 * server-side, and it cannot reach that route usefully: it would need an
 * absolute URL, and the route sits behind the auth proxy so a cookieless
 * request is redirected to /login. Calling over HTTP from inside the same
 * process to reach a function would also be silly.
 *
 * So the prompt, response schema and calibration rules live here, and the
 * route is now a thin HTTP wrapper over `analyseImage()`. One prompt, one set
 * of calibration rules, two callers.
 */

// gemini-2.5-flash was retired for new API keys — Google 404s it with
// "no longer available to new users". Override with GEMINI_MODEL.
const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.6-flash";
const ENDPOINT = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

export const SEVERITY_VALUES = ["minor", "moderate", "severe"] as const;
export type LLMSeverity = (typeof SEVERITY_VALUES)[number];

const SCHEMA = {
  type: "OBJECT",
  properties: {
    category: { type: "STRING", enum: [...CATEGORY_VALUES] },
    severity: { type: "STRING", enum: [...SEVERITY_VALUES] },
    confidence: { type: "NUMBER" },
    reason: { type: "STRING" },
    // Face boxes ride along on the call we were already making. The WhatsApp
    // intake has no browser to run blazeface in, so this is the only chance to
    // find a face before the photo reaches an authority and a public feed.
    faces: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          ymin: { type: "NUMBER" },
          xmin: { type: "NUMBER" },
          ymax: { type: "NUMBER" },
          xmax: { type: "NUMBER" },
        },
        required: ["ymin", "xmin", "ymax", "xmax"],
      },
    },
  },
  required: ["category", "severity", "confidence", "reason", "faces"],
};

const SYSTEM = `You analyse photographs of civic defects reported by residents in Indian cities.

Return exactly:
  category  — one value from the allowed list
  severity  — minor | moderate | severe, estimated by what fraction of the
               visible frame the defect covers (minor < 10%, moderate 10-40%,
               severe > 40% or if it poses an immediate safety hazard)
  confidence — a single calibrated number 0-1 covering both answers
  reason     — at most 12 words naming the visible evidence
  faces      — a bounding box for EVERY human face visible, however small,
               distant, partially turned or in shadow. Coordinates normalised
               0-1000 as ymin, xmin, ymax, xmax. Empty array if there are none.
               Err towards including a box: a missed face is a privacy failure,
               an extra one only blurs some road.

Calibration rules:
- If the photo is dark, blurry, heavily cropped, or ambiguous, return confidence < 0.4.
- If nothing resembling a civic defect is visible, return category "other" and low confidence.
- Do not guess confidently when the evidence is unclear.

Known confusers: wet patches and shadows look like potholes; manhole covers are not potholes;
a storm water drain is a kerbside grated inlet; sewage overflow involves standing effluent.`;

export function visionConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

/**
 * Every outcome is a value, not an exception — the callers all degrade rather
 * than fail, and the distinctions matter to them: `unconfigured` means nobody
 * set a key, `rateLimited` means the free tier is spent (worth saying out loud
 * to a citizen), `refused` means the model declined to answer.
 */
/** Normalised 0-1000, as Gemini returns detection boxes. */
export interface FaceBox {
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
}

export type VisionResult =
  | {
      ok: true;
      category: IssueCategory;
      severity: LLMSeverity;
      confidence: number;
      reason: string;
      faces: FaceBox[];
    }
  | { ok: false; kind: "unconfigured" }
  | { ok: false; kind: "refused" }
  | { ok: false; kind: "rateLimited"; error: string }
  | { ok: false; kind: "error"; error: string };

/** Accepts a `data:image/(jpeg|png|webp);base64,...` URL. */
export async function analyseImage(dataUrl: string): Promise<VisionResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { ok: false, kind: "unconfigured" };

  const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(dataUrl ?? "");
  if (!match) return { ok: false, kind: "error", error: "Expected a base64 image data URL" };
  const [, mimeType, base64] = match;

  try {
    const res = await fetch(ENDPOINT(MODEL), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [
          {
            role: "user",
            parts: [
              { inline_data: { mime_type: mimeType, data: base64 } },
              {
                text: "Analyse this civic defect: return category, severity, confidence, and reason.",
              },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: SCHEMA,
          // No thinkingConfig: `thinkingBudget: 0` was a latency/cost trim on
          // 2.5-flash, and gemini-3.x rejects the whole request with a bare
          // 400 "invalid argument" for it — which surfaces here as an
          // unexplained refusal to verify. Not worth re-adding under a
          // version sniff for the milliseconds it saved.
          maxOutputTokens: 1024,
        },
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error(`[vision] Gemini ${res.status}:`, detail.slice(0, 500));
      const error = `Gemini ${res.status}: ${detail.slice(0, 200)}`;
      // 429 = free-tier quota exhausted. Distinguished so the UI can give the
      // citizen the honest reason rather than a generic "didn't work".
      return res.status === 429
        ? { ok: false, kind: "rateLimited", error }
        : { ok: false, kind: "error", error };
    }

    const payload = await res.json();
    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return { ok: false, kind: "refused" };

    const parsed = parseLoosely(text);
    if (!parsed) return { ok: false, kind: "error", error: "Model did not return JSON" };

    return {
      ok: true,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
      category: (CATEGORY_VALUES as readonly string[]).includes(String(parsed.category))
        ? (parsed.category as IssueCategory)
        : "other",
      severity: (SEVERITY_VALUES as readonly string[]).includes(String(parsed.severity))
        ? (parsed.severity as LLMSeverity)
        : "moderate",
      reason: String(parsed.reason ?? "").slice(0, 120),
      faces: Array.isArray(parsed.faces)
        ? (parsed.faces as unknown[])
            .map((f) => f as Record<string, unknown>)
            .map((f) => ({
              ymin: Number(f.ymin),
              xmin: Number(f.xmin),
              ymax: Number(f.ymax),
              xmax: Number(f.xmax),
            }))
            .filter(
              (b) =>
                [b.ymin, b.xmin, b.ymax, b.xmax].every(Number.isFinite) &&
                b.ymax > b.ymin &&
                b.xmax > b.xmin
            )
        : [],
    };
  } catch (error) {
    return {
      ok: false,
      kind: "error",
      error: error instanceof Error ? error.message : "Analysis failed",
    };
  }
}
