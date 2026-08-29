import { NextResponse } from "next/server";
import { resolveAuthorityFull } from "@/lib/resolve-authority";
import type { IssueCategory } from "@/lib/types";

/**
 * Resolves the responsible authority for a coordinate.
 *
 * Serves the FULL tier chain (see src/lib/resolve-authority.ts), not just the
 * spatial Tiers 1-2 it used to. The LLM and generic-municipal fallbacks were
 * previously bolted on client-side in pipeline.ts, which meant the browser and
 * the WhatsApp webhook resolved differently for the same coordinate. Now both
 * get the same answer from the same code.
 *
 * Response shape is unchanged — `{ routing, ms }` — so existing callers are
 * unaffected; `routing.authorities` is simply no longer empty for locations
 * outside our verified registry.
 */

export const runtime = "nodejs";

export async function POST(req: Request) {
  let lat: unknown, lng: unknown, category: unknown;
  try {
    ({ lat, lng, category } = await req.json());
  } catch {
    return NextResponse.json({ error: "Malformed body" }, { status: 400 });
  }

  if (typeof lat !== "number" || typeof lng !== "number") {
    return NextResponse.json({ error: "lat and lng required" }, { status: 400 });
  }

  const outcome = await resolveAuthorityFull(
    lat,
    lng,
    (category as IssueCategory) ?? "pothole"
  );

  if (!outcome.ok) {
    return NextResponse.json({ error: "Routing unavailable" }, { status: 502 });
  }

  return NextResponse.json({ routing: outcome.routing, ms: outcome.ms });
}
