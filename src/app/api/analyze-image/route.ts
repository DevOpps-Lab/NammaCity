import { NextResponse, type NextRequest } from "next/server";
import { CATEGORY_VALUES, type IssueCategory } from "@/lib/types";

/**
 * COMBINED IMAGE ANALYSER
 *
 * A single Gemini call returns BOTH the category AND the severity in one round
 * trip, replacing the two-pass approach of detect.ts (CV heuristic) +
 * /api/classify (category only).
 *
 * Severity buckets:
 *   minor    — defect is small, localised, low immediate risk
 *   moderate — defect is noticeable, significant portion of the frame
 *   severe   — defect dominates the frame or poses an immediate hazard
 *
 * The model is asked to estimate severity by how much of the visible frame the
 * defect covers, which avoids impossible monocular depth estimation.
 *
 * Confidence is a single calibrated number that covers the whole answer.
 * Below 0.25 the client forces the user to choose; below 0.45 the client
 * pre-fills but shows the picker.
 */

export const runtime = "nodejs";

const MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
const ENDPOINT = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

const SEVERITY_VALUES = ["minor", "moderate", "severe"] as const;
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

function parseLoosely(text: string): Record<string, unknown> | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

export async function POST(request: NextRequest) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
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
    return NextResponse.json({ error: "Expected a base64 image data URL" }, { status: 400 });
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
              { text: "Analyse this civic defect: return category, severity, confidence, and reason." },
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
      // Log the full error to the server terminal so it's easy to diagnose.
      console.error(`[analyze-image] Gemini ${res.status}:`, detail.slice(0, 500));
      // 429 = free-tier quota exhausted (gemini-2.5-flash allows ~20 req/day).
      // Flag it distinctly so the UI can tell the citizen the honest reason
      // rather than a generic "didn't work".
      return NextResponse.json(
        {
          configured: true,
          rateLimited: res.status === 429,
          error: `Gemini ${res.status}: ${detail.slice(0, 200)}`,
        },
        { status: 502 }
      );
    }

    const payload = await res.json();

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

    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    const category = (CATEGORY_VALUES as readonly string[]).includes(String(parsed.category))
      ? (parsed.category as IssueCategory)
      : "other";
    const severity = (SEVERITY_VALUES as readonly string[]).includes(String(parsed.severity))
      ? (parsed.severity as LLMSeverity)
      : "moderate";

    return NextResponse.json({
      configured: true,
      category,
      severity,
      confidence,
      reason: String(parsed.reason ?? "").slice(0, 120),
    });
  } catch (error) {
    return NextResponse.json(
      {
        configured: true,
        error: error instanceof Error ? error.message : "Analysis failed",
      },
      { status: 502 }
    );
  }
}
