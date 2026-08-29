import { NextResponse, type NextRequest } from "next/server";
import { CATEGORY_VALUES, type IssueCategory } from "@/lib/types";

/**
 * CATEGORY CLASSIFIER
 *
 * `detect.ts` deliberately refuses to infer the category from pixels — a
 * classical CV heuristic cannot separate a pile of garbage from a pile of
 * sandbags, and filing to the wrong agency on a bad guess is exactly the
 * failure this product argues against. A vision model can do what the heuristic
 * could not.
 *
 * Three constraints keep that from becoming silent guessing:
 *
 *  1. It runs SERVER-SIDE, so the key never reaches the browser — and the auth
 *     proxy covers /api, so it cannot be used anonymously to burn quota.
 *  2. It returns a confidence, and the UI gates the one-tap path on it. Below
 *     the floor in `classify.ts` the citizen must choose the category.
 *  3. The photo is the ALREADY-REDACTED frame — faces pixelated and EXIF
 *     stripped on-device by imaging.ts. The original never leaves the phone,
 *     and that stays true even though this now goes off-device.
 *
 * Provider: Google Gemini, called over plain REST rather than through an SDK —
 * the request is one JSON body and adding a client library for it would be more
 * moving parts than the feature needs. Chosen for the free tier (~1,500
 * classifications/day, no card), which comfortably covers a demo.
 *
 * With no key configured the route reports `configured: false` rather than
 * failing, and the client falls back to ASKING the citizen. Degrading to a
 * question is honest; degrading to a weak guess is not.
 */

export const runtime = "nodejs";

/** Stable, multimodal, and on the free tier. Override if quota dictates. */
// gemini-2.5-flash was retired for new API keys — Google 404s it with
// "no longer available to new users". Override with GEMINI_MODEL.
const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.6-flash";
const ENDPOINT = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    category: { type: "STRING", enum: [...CATEGORY_VALUES] },
    confidence: { type: "NUMBER" },
    reason: { type: "STRING" },
  },
  required: ["category", "confidence", "reason"],
};

const SYSTEM = `You classify photographs of civic defects reported by residents in Chennai, India.

Return exactly one category from the allowed list, a calibrated confidence between
0 and 1, and a reason of at most 12 words naming the visible evidence.

Calibration matters more than decisiveness. A wrong category files the complaint
to the wrong government agency, so:
- If the defect is ambiguous, or the photo is dark, blurry or heavily cropped,
  return a confidence below 0.4.
- If nothing resembling a civic defect is visible, return "other" with low confidence.
- Do not guess a specific category to seem helpful. A low confidence is a useful
  answer; a confident wrong answer is not.

Known confusers: wet patches and shadows look like potholes; manhole covers and
road patches are not potholes; a storm water drain is a kerbside grated inlet,
whereas sewage overflow involves standing or flowing effluent.`;

interface RawResult {
  category?: string;
  confidence?: number;
  reason?: string;
}

/**
 * Parse the model's answer without trusting it to be clean JSON.
 *
 * `responseSchema` is supposed to guarantee this, and mostly does — but it was
 * observed returning a prose preamble ("Here is the...") when the output budget
 * ran short, which crashed a bare JSON.parse. A classifier that throws on an
 * unexpected wrapper is more fragile than the thing it is classifying, so strip
 * code fences and fall back to the first balanced object in the string.
 */
function parseLoosely(text: string): RawResult | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  try {
    return JSON.parse(cleaned) as RawResult;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as RawResult;
    } catch {
      return null;
    }
  }
}

export async function POST(request: NextRequest) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    // Not an error — a configuration state the client knows how to handle.
    return NextResponse.json({ configured: false }, { status: 200 });
  }

  let dataUrl: string;
  try {
    ({ dataUrl } = await request.json());
  } catch {
    return NextResponse.json({ error: "Malformed body" }, { status: 400 });
  }

  const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(dataUrl ?? "");
  if (!match) {
    return NextResponse.json(
      { error: "Expected a base64 image data URL" },
      { status: 400 }
    );
  }
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
              { text: "Classify this civic defect." },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: SCHEMA,
          // Thinking is on by default on 2.5-flash and is billed against the
          // SAME output budget. At maxOutputTokens: 256 it starved the answer
          // and the model fell back to prose ("Here is the..."), which is not
          // parseable JSON. This is a classification, not a reasoning task —
          // turn thinking off and leave generous headroom.
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
      // 429 here means the free-tier daily quota is spent. The client treats
      // every error the same way — by asking the citizen — so this only needs
      // to be legible in logs.
      return NextResponse.json(
        { configured: true, error: `Gemini ${res.status}: ${detail.slice(0, 200)}` },
        { status: 502 }
      );
    }

    const payload = await res.json();

    // A safety block returns 200 with no candidate content.
    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return NextResponse.json({ configured: true, refused: true }, { status: 200 });
    }

    const parsed = parseLoosely(text);
    if (!parsed) {
      return NextResponse.json(
        { configured: true, error: "Model did not return JSON" },
        { status: 502 }
      );
    }

    // Never trust the model's own bounds — the UI gates on this number.
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    const category = (CATEGORY_VALUES as readonly string[]).includes(parsed.category ?? "")
      ? (parsed.category as IssueCategory)
      : "other";

    return NextResponse.json({
      configured: true,
      category,
      confidence,
      reason: String(parsed.reason ?? "").slice(0, 120),
    });
  } catch (error) {
    // Network failure or bad JSON. The client falls back to asking.
    return NextResponse.json(
      {
        configured: true,
        error: error instanceof Error ? error.message : "Classification failed",
      },
      { status: 502 }
    );
  }
}
