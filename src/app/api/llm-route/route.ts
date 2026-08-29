import { NextResponse, type NextRequest } from "next/server";
import { routeByLLM, llmRoutingConfigured } from "@/lib/llm-route";

/**
 * LLM ROUTING FALLBACK — HTTP shape only.
 *
 * Only reached when deterministic spatial routing (routing.ts) resolves a
 * location but finds no verified contact registry for it — i.e. outside
 * Chennai, where we have no ward polygon data. Tier 1 (GCC polygons) and
 * Tier 2 (OSM) are untouched by this path.
 *
 * The provider call now lives in `src/lib/llm-route.ts` so the WhatsApp webhook
 * can use it in-process; this route cannot serve that caller because it sits
 * behind the auth proxy.
 *
 * Nothing in the app calls this route any more — the browser resolves through
 * /api/route-authority, which runs the whole tier chain server-side. Kept as a
 * documented seam for debugging a single city's routing in isolation.
 */

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  // Checked before parsing the body, preserving the original contract: an
  // unconfigured deployment answers `{configured:false}` regardless of input.
  if (!llmRoutingConfigured()) {
    return NextResponse.json({ configured: false }, { status: 200 });
  }

  let city: string, category: string;
  try {
    ({ city, category } = await request.json());
  } catch {
    return NextResponse.json({ error: "Malformed body" }, { status: 400 });
  }

  if (!city || !category) {
    return NextResponse.json({ error: "city and category are required" }, { status: 400 });
  }

  const result = await routeByLLM(city, category);

  if (result.ok) {
    return NextResponse.json({ configured: true, ...result.route });
  }

  switch (result.kind) {
    case "unconfigured":
      return NextResponse.json({ configured: false }, { status: 200 });
    case "refused":
      return NextResponse.json({ configured: true, refused: true }, { status: 200 });
    default:
      return NextResponse.json({ configured: true, error: result.error }, { status: 502 });
  }
}
