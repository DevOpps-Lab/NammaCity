import { NextResponse } from "next/server";
import type { DashcamDetection } from "@/lib/dashcam-detect";

/**
 * DASHCAM DETECTION — authenticated front door to the inference sidecar.
 *
 * The sidecar (detector/server.py) binds to 127.0.0.1 and has no auth of its
 * own. That is deliberate: this route IS its auth. `/api/dashcam/` is absent
 * from PUBLIC_PATHS in src/proxy.ts, so an unauthenticated request is redirected
 * to /login before it ever arrives here, and nothing outside the box can reach
 * port 8001 (ufw allows 22/80/443 only).
 *
 * Why proxy at all rather than expose the Python port: exposing it would mean
 * inventing a second auth scheme for a service that runs YOLO on whatever bytes
 * it is handed. Borrowing the session boundary that already exists is both less
 * code and a smaller surface.
 *
 * Optional by design. When the sidecar is down this returns 503 with
 * `available: false`, and the client falls back to the in-browser ONNX detector
 * it has always used — a dashcam that stops working because a Python service
 * restarted would be a worse feature than the one we started with.
 */

export const runtime = "nodejs";

const SIDECAR = process.env.DETECTOR_URL ?? "http://127.0.0.1:8001";

/** Inference is slow on CPU — ~370ms per model measured — so allow real time. */
const TIMEOUT_MS = 20_000;

/** The bucket ceiling elsewhere in the app; a video frame is far smaller. */
const MAX_FRAME_BYTES = 5 * 1024 * 1024;

export interface DashcamDetectResponse {
  available: boolean;
  detections: DashcamDetection[];
  ms?: number;
  models?: string[];
  reason?: string;
}

export async function POST(req: Request) {
  let frame: File | null = null;
  let conf: string | null = null;
  try {
    const form = await req.formData();
    const value = form.get("frame");
    if (value instanceof File) frame = value;
    const c = form.get("conf");
    // Validated rather than forwarded blind: this reaches a model's confidence
    // floor, and NaN or a negative would come back as every anchor in the grid.
    if (typeof c === "string") {
      const n = Number(c);
      if (Number.isFinite(n) && n > 0 && n < 1) conf = String(n);
    }
  } catch {
    return NextResponse.json({ error: "Expected multipart form data" }, { status: 400 });
  }
  if (!frame) {
    return NextResponse.json({ error: "frame required" }, { status: 400 });
  }
  if (frame.size > MAX_FRAME_BYTES) {
    return NextResponse.json({ error: "Frame too large" }, { status: 413 });
  }

  const upstream = new FormData();
  upstream.append("frame", frame, "frame.jpg");
  if (conf) upstream.append("conf", conf);

  try {
    const res = await fetch(`${SIDECAR}/infer`, {
      method: "POST",
      body: upstream,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn(`[dashcam] sidecar returned ${res.status}: ${detail.slice(0, 160)}`);
      return NextResponse.json<DashcamDetectResponse>(
        { available: false, detections: [], reason: `detector returned ${res.status}` },
        { status: 503 }
      );
    }

    const body = (await res.json()) as {
      detections?: DashcamDetection[];
      ms?: number;
      perModel?: Record<string, unknown>;
    };

    return NextResponse.json<DashcamDetectResponse>({
      available: true,
      detections: body.detections ?? [],
      ms: body.ms,
      models: Object.keys(body.perModel ?? {}),
    });
  } catch (err) {
    // Down, restarting, or slower than the budget. All three mean the same
    // thing to the caller: use the local detector for this frame.
    console.warn(
      "[dashcam] sidecar unreachable:",
      err instanceof Error ? err.message : String(err)
    );
    return NextResponse.json<DashcamDetectResponse>(
      { available: false, detections: [], reason: "detector unavailable" },
      { status: 503 }
    );
  }
}

/** Lets the client decide whether to offer the remote option at all. */
export async function GET() {
  try {
    const res = await fetch(`${SIDECAR}/health`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return NextResponse.json({ available: false });
    const health = (await res.json()) as { models?: string[] };
    return NextResponse.json({ available: true, models: health.models ?? [] });
  } catch {
    return NextResponse.json({ available: false });
  }
}
