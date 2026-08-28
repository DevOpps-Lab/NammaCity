"use client";

/**
 * DASHCAM POTHOLE DETECTION
 *
 * Runs a real, trained pothole-detection model entirely in the browser via
 * Roboflow's `inferencejs` SDK (WebGL under the hood) — not a generic coco-ssd
 * placeholder, and not a per-frame server round trip.
 *
 * Mirrors tfjs-redact.ts's lazy-load shape: dynamic import so the heavy
 * TF.js/mediapipe bundle inferencejs pulls in never lands in the initial JS
 * chunk, and a module-level cache so switching into the Dashcam tab twice
 * doesn't reload/restart the worker.
 *
 * Takes a canvas, not the source video, because DashcamTab draws the video
 * frame (plus its own overlay) onto a canvas every tick — that canvas is the
 * only thing actually visible, so it's also what gets inferred on. The
 * installed inferencejs's `infer()` only accepts a `CVImage` or
 * `ImageBitmap` (see node_modules/inferencejs/dist/webworker/inferenceEngine.d.ts),
 * so a canvas is converted via `createImageBitmap()` before every call.
 */

export interface DashcamDetection {
  /** Top-left based, in the same pixel space as the source canvas. */
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  classLabel: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let engineCache: any = null;
let workerIdCache: string | null = null;
let loadPromise: Promise<{ engine: unknown; workerId: string } | null> | null = null;

/**
 * Class names accepted from the model as "this is a pothole". Verify the
 * exact casing emitted by whichever Roboflow Universe model is configured —
 * some pothole datasets label extra classes (crack, manhole, etc.) that must
 * NOT trigger a capture.
 */
const POTHOLE_CLASSES = new Set(["pothole", "pot-hole", "potholes"]);

export function dashcamConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_ROBOFLOW_API_KEY && process.env.NEXT_PUBLIC_ROBOFLOW_MODEL
  );
}

async function loadWorker() {
  if (!dashcamConfigured()) return null;
  if (engineCache && workerIdCache) return { engine: engineCache, workerId: workerIdCache };
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { InferenceEngine } = (await import("inferencejs")) as any;
      // NEXT_PUBLIC_ROBOFLOW_MODEL is "<project-slug>/<version>" — the
      // installed inferencejs's own README calls this the "legacy" shape and
      // reserves it for `startWorker(modelName, modelVersion, key)`.
      // `startWorkerByModelId` is for a *versionless* `workspace/slug` id and
      // will not resolve a slug/version pair correctly.
      const [slug, version] = process.env.NEXT_PUBLIC_ROBOFLOW_MODEL!.split("/");
      const engine = new InferenceEngine();
      const workerId: string = await engine.startWorker(
        slug,
        Number(version),
        process.env.NEXT_PUBLIC_ROBOFLOW_API_KEY!
      );
      engineCache = engine;
      workerIdCache = workerId;
      return { engine, workerId };
    } catch (err) {
      console.warn("[dashcam-detect] Roboflow worker failed to start:", err);
      return null;
    }
  })();

  return loadPromise;
}

/**
 * Runs one inference pass on the given canvas and returns pothole detections
 * only, with Roboflow's center-based bbox normalized to top-left so canvas
 * drawing and cropping code can treat it like any other rect.
 */
export async function detectPotholes(source: HTMLCanvasElement): Promise<DashcamDetection[]> {
  const ctx = await loadWorker();
  if (!ctx) return [];

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(source);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const predictions: any[] = await (ctx.engine as any).infer(ctx.workerId, bitmap);

    return predictions
      .filter((p) => POTHOLE_CLASSES.has(String(p.class).toLowerCase()))
      .map((p) => ({
        x: p.bbox.x - p.bbox.width / 2,
        y: p.bbox.y - p.bbox.height / 2,
        width: p.bbox.width,
        height: p.bbox.height,
        confidence: p.confidence,
        classLabel: p.class,
      }));
  } catch (err) {
    console.warn("[dashcam-detect] inference failed:", err);
    return [];
  } finally {
    bitmap?.close();
  }
}
