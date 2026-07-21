import { NextResponse, type NextRequest } from "next/server";
import { verifyAfterPhoto } from "@/lib/verify-vision";

/**
 * AFTER-PHOTO VERIFICATION (vision-assisted). Thin wrapper over the shared
 * `verifyAfterPhoto` in lib/verify-vision.ts, which the server-side
 * authority-photo close path reuses so the two agree.
 *
 * Hybrid: no key (or 429) -> `configured:false`/`rateLimited` and the client
 * falls back to the resident confirming their own photo. A photo is always
 * required to close.
 */

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  let afterDataUrl: string, beforeUrl: string | undefined, category: string | undefined;
  try {
    ({ afterDataUrl, beforeUrl, category } = await request.json());
  } catch {
    return NextResponse.json({ error: "Malformed body" }, { status: 400 });
  }
  if (!afterDataUrl) {
    return NextResponse.json({ error: "afterDataUrl required" }, { status: 400 });
  }

  const result = await verifyAfterPhoto({ afterDataUrl, beforeUrl, category });
  const status = result.configured === false ? 200 : result.error ? 502 : 200;
  return NextResponse.json(result, { status });
}
