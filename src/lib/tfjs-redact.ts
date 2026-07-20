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

async function loadModel() {
  if (modelCache) return modelCache;
  if (loadPromise) return loadPromise;

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

  return loadPromise;
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

    const regions: BlurRegion[] = predictions.map((p) => {
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
