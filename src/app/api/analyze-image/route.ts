import { NextResponse, type NextRequest } from "next/server";
import { analyseImage } from "@/lib/vision";

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
 *
 * The analysis itself now lives in `src/lib/vision.ts`, because the WhatsApp
 * webhook needs it in-process and cannot go through this route (it is behind
 * the auth proxy, and a cookieless request is redirected to /login). This
 * handler is the HTTP shape only; the response contract is unchanged, since
 * `src/lib/llm-analyze.ts` on the client parses these exact fields.
 */

export const runtime = "nodejs";

// Re-exported because `src/lib/severity.ts` and llm-analyze.ts import the type
// from here; moving it would ripple further than this refactor needs to.
export type { LLMSeverity } from "@/lib/vision";

export async function POST(request: NextRequest) {
  let dataUrl: string;
  try {
    ({ dataUrl } = await request.json());
  } catch {
    return NextResponse.json({ error: "Malformed body" }, { status: 400 });
  }

  const result = await analyseImage(dataUrl);

  if (result.ok) {
    return NextResponse.json({
      configured: true,
      category: result.category,
      severity: result.severity,
      confidence: result.confidence,
      reason: result.reason,
      // Normalised 0-1000 boxes; the client (llm-analyze.ts) scales them to the
      // frame it is about to redact.
      faces: result.faces,
      plates: result.plates,
    });
  }

  switch (result.kind) {
    case "unconfigured":
      return NextResponse.json({ configured: false }, { status: 200 });
    case "refused":
      return NextResponse.json({ configured: true, refused: true }, { status: 200 });
    case "rateLimited":
      return NextResponse.json(
        { configured: true, rateLimited: true, error: result.error },
        { status: 502 }
      );
    default:
      // A malformed data URL is the caller's fault, not the provider's — keep
      // the original 400 rather than reporting it as an upstream failure.
      if (result.error === "Expected a base64 image data URL") {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      return NextResponse.json({ configured: true, error: result.error }, { status: 502 });
  }
}
