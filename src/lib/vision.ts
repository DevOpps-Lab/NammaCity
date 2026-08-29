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

const MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
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
  },
  required: ["category", "severity", "confidence", "reason"],
};

const SYSTEM = `You analyse photographs of civic defects reported by residents in Indian cities.

Return exactly:
  category  — one value from the allowed list
  severity  — minor | moderate | severe, estimated by what fraction of the
               visible frame the defect covers (minor < 10%, moderate 10-40%,
               severe > 40% or if it poses an immediate safety hazard)
  confidence — a single calibrated number 0-1 covering both answers
  reason     — at most 12 words naming the visible evidence

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
export type VisionResult =
  | {
      ok: true;
      category: IssueCategory;
      severity: LLMSeverity;
      confidence: number;
      reason: string;
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
          thinkingConfig: { thinkingBudget: 0 },
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
    };
  } catch (error) {
    return {
      ok: false,
      kind: "error",
      error: error instanceof Error ? error.message : "Analysis failed",
    };
  }
}
