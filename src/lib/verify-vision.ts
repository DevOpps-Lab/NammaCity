/**
 * Shared after-photo verification (Gemini vision). Used by BOTH the client-
 * facing /api/verify-image route and the server-side authority-photo close path
 * in correspondence-apply, so the two agree by construction.
 *
 * Hybrid: no GEMINI_API_KEY -> { configured:false }. The caller then either
 * asks the resident to confirm manually (client) or declines to auto-close
 * (server) — no verification, no closure.
 */

const MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
const ENDPOINT = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    placeMatch: { type: "NUMBER" },
    defectResolved: { type: "NUMBER" },
    confidence: { type: "NUMBER" },
    reason: { type: "STRING" },
  },
  required: ["placeMatch", "defectResolved", "confidence", "reason"],
};

const SYSTEM = `You verify whether a civic defect has been repaired, by comparing a BEFORE photo (the original report) with an AFTER photo.

Return:
  placeMatch     — 0-1 confidence the two photos show the SAME location/scene
  defectResolved — 0-1 confidence the reported defect is now GONE (repaired)
  confidence     — 0-1 overall calibrated confidence
  reason         — at most 15 words on the visible evidence

Rules:
- If the after-photo looks like a DIFFERENT place, placeMatch must be low (<0.5).
- If the defect is still visible, defectResolved must be low.
- Absence of the defect is evidence of repair, but be conservative if unclear.`;

export type VerifyVerdict = "likely_repaired" | "still_present" | "inconclusive";

export interface VisionVerifyResult {
  configured: boolean;
  rateLimited?: boolean;
  error?: string;
  verdict?: VerifyVerdict;
  placeMatch?: number;
  defectResolved?: number;
  confidence?: number;
  reason?: string;
}

function clamp01(n: unknown): number {
  const x = Number(n);
  return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
}

function parseLoosely(text: string): Record<string, unknown> | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const s = cleaned.indexOf("{");
    const e = cleaned.lastIndexOf("}");
    if (s === -1 || e <= s) return null;
    try {
      return JSON.parse(cleaned.slice(s, e + 1)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

export function verdictOf(placeMatch: number, defectResolved: number): VerifyVerdict {
  if (placeMatch < 0.6) return "inconclusive";
  if (defectResolved < 0.5) return "still_present";
  return "likely_repaired";
}

/** data: URL or an http(s) URL -> inline base64 for the model. */
export async function toInline(
  src: string | undefined | null
): Promise<{ mimeType: string; data: string } | null> {
  if (!src) return null;
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/i.exec(src);
  if (m) return { mimeType: m[1], data: m[2] };
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      mimeType: res.headers.get("content-type") ?? "image/jpeg",
      data: buf.toString("base64"),
    };
  } catch {
    return null;
  }
}

export async function verifyAfterPhoto(input: {
  afterDataUrl: string;
  beforeUrl?: string;
  category?: string;
}): Promise<VisionVerifyResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { configured: false };

  const after = await toInline(input.afterDataUrl);
  if (!after) return { configured: true, error: "no after image" };
  const before = await toInline(input.beforeUrl);

  const parts: object[] = [];
  if (before) {
    parts.push({ text: "BEFORE (original report):" });
    parts.push({ inline_data: { mime_type: before.mimeType, data: before.data } });
  }
  parts.push({ text: "AFTER (follow-up photo):" });
  parts.push({ inline_data: { mime_type: after.mimeType, data: after.data } });
  parts.push({
    text: `Reported defect category is "${input.category ?? "unknown"}". Assess placeMatch, defectResolved, confidence, reason.`,
  });

  try {
    const res = await fetch(ENDPOINT(MODEL), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: SCHEMA,
          thinkingConfig: { thinkingBudget: 0 },
          maxOutputTokens: 1024,
        },
      }),
    });

    if (!res.ok) {
      return { configured: true, rateLimited: res.status === 429, error: `Gemini ${res.status}` };
    }
    const payload = await res.json();
    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = text ? parseLoosely(text) : null;
    if (!parsed) return { configured: true, error: "no JSON" };

    const placeMatch = clamp01(parsed.placeMatch);
    const defectResolved = clamp01(parsed.defectResolved);
    return {
      configured: true,
      placeMatch,
      defectResolved,
      confidence: clamp01(parsed.confidence),
      verdict: verdictOf(placeMatch, defectResolved),
      reason: String(parsed.reason ?? "").slice(0, 140),
    };
  } catch (e) {
    return { configured: true, error: e instanceof Error ? e.message : "verify failed" };
  }
}
