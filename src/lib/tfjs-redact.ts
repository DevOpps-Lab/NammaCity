"use client";

/**
 * TFJS FACE REDACTION
 *
 * Replaces the browser-native FaceDetector (Chromium-only, patchy) with
 * blazeface — a lightweight TensorFlow.js model that runs consistently in all
 * modern browsers.
 *
 * The model weights (~4 MB) are lazy-loaded on the first call so they never
 * block the initial page paint. On every subsequent call the loaded model is
 * reused from the module-level cache.
 *
 * Returns the same BlurRegion[] shape that imaging.ts already consumes, so
 * nothing else in the pipeline changes.
 */

import type { BlurRegion } from "./imaging";

// Module-level cache — one load per browser session.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let modelCache: any = null;
let loadPromise: Promise<unknown> | null = null;

/**
 * How long one photo will wait for the face model before giving up on it.
 *
 * blazeface.load() pulls weights from a Google CDN, and NOTHING in that path
 * has a timeout — so on a slow, throttled or CDN-blocked network the promise
 * simply never settles. `detectFacesWithTFJS` already degrades to manual review
 * on failure, but a hang is not a failure: it never reaches the catch, so the
 * Report tab sat on "Redacting faces on your device…" forever, and because
 * `loadPromise` is cached module-wide every retry re-awaited the same dead
 * promise. Only a page reload escaped.
 *
 * The download is deliberately NOT cancelled on timeout. It keeps running, so a
 * second attempt either finds `modelCache` populated or races a load that is
 * already part-done — retries get faster instead of starting over.
 */
const MODEL_LOAD_TIMEOUT_MS = 12_000;

async function loadModel() {
  if (modelCache) return modelCache;
  if (loadPromise) return withTimeout(loadPromise);

  loadPromise = (async () => {
    // Dynamic imports so the heavy TF.js bundle is never included in the
    // initial JS chunk — it only loads when a user opens the Report tab and
    // picks a photo.
    const tf = await import("@tensorflow/tfjs");
    const blazeface = await import("@tensorflow-models/blazeface");

    // WebGL backend gives the best performance; fall back to WASM then CPU.
    try {
      await tf.setBackend("webgl");
    } catch {
      try {
        await tf.setBackend("wasm");
      } catch {
        await tf.setBackend("cpu");
      }
    }
    await tf.ready();

    modelCache = await blazeface.load();
    return modelCache;
  })();

  // A rejection that nobody is awaiting yet (the timeout branch below returns
  // first) would otherwise surface as an unhandled rejection in the console.
  loadPromise.catch(() => {});

  return withTimeout(loadPromise);
}

/**
 * Bounds the wait without touching the underlying load. Throwing is the point:
 * it routes into the existing catch in `detectFacesWithTFJS`, which reports
 * `supported: false` — and the UI already treats that as "we could not check
 * for faces, review this photo yourself" rather than implying it is clean.
 */
function withTimeout(p: Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `blazeface model did not load within ${MODEL_LOAD_TIMEOUT_MS}ms (network or CDN)`
            )
          ),
        MODEL_LOAD_TIMEOUT_MS
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

export interface TFJSRedactResult {
  regions: BlurRegion[];
  /** false when TF.js itself failed to load or run — degrade to manual blur. */
  supported: boolean;
  /** Which backend TF.js chose (for the Agent Trace). */
  backend?: string;
}

/**
 * Runs blazeface on the given image element and returns face bounding boxes
 * in source-image pixel coordinates, ready to pass to redactRegion() in
 * imaging.ts.
 */
export async function detectFacesWithTFJS(
  source: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement
): Promise<TFJSRedactResult> {
  try {
    const model = await loadModel();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const predictions: any[] = await (model as any).estimateFaces(source, false);

    const tf = await import("@tensorflow/tfjs");
    const backend = tf.getBackend();

    const regions: BlurRegion[] = predictions
      // Blazeface scores every candidate, and this used to blur all of them
      // regardless — so a pothole, a manhole rim or a patch of gravel could be
      // pixelated as a "face" on a photo containing no people at all. The
      // threshold is deliberately low: a missed face is a privacy failure and a
      // spurious blur is only cosmetic, so this trims obvious noise rather than
      // trying to be strict.
      .filter((p) => {
        const raw = Array.isArray(p.probability)
          ? p.probability[0]
          : typeof p.probability === "number"
            ? p.probability
            : p.probability?.arraySync?.()?.[0];
        // A build that reports no score at all must still blur — absence of a
        // score is not evidence that it isn't a face.
        return typeof raw !== "number" || raw >= 0.6;
      })
      .map((p) => {
      // blazeface topLeft / bottomRight are [x, y] tensors or plain arrays.
      const tl = Array.isArray(p.topLeft) ? p.topLeft : p.topLeft.arraySync();
      const br = Array.isArray(p.bottomRight) ? p.bottomRight : p.bottomRight.arraySync();

      return {
        x: tl[0],
        y: tl[1],
        w: br[0] - tl[0],
        h: br[1] - tl[1],
      };
    });

    return { regions, supported: true, backend };
  } catch (err) {
    console.warn("[tfjs-redact] blazeface failed, falling back to manual blur:", err);
    return { regions: [], supported: false };
  }
}
