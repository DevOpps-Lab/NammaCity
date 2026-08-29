"use client";

/**
 * TFJS FACE REDACTION
 *
 * Replaces the browser-native FaceDetector (Chromium-only, patchy) with
 * blazeface — a lightweight TensorFlow.js model that runs consistently in all
 * modern browsers.
 *
 * The model (466 KB, self-hosted from /models/blazeface) is lazy-loaded on the
 * first call so it never blocks the initial page paint. On every subsequent
 * call the loaded model is reused from the module-level cache.
 *
 * The "~4 MB" this comment used to claim was the TF.js LIBRARY, not the model —
 * which mattered, because it made a slow first run look like an unavoidable
 * cost of a big download rather than a fetch from a third-party CDN.
 *
 * Returns the same BlurRegion[] shape that imaging.ts already consumes, so
 * nothing else in the pipeline changes.
 */

import type { BlurRegion } from "./imaging";

/** Self-hosted so face redaction never depends on a third-party CDN. */
const MODEL_URL = "/models/blazeface/model.json";

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
const MODEL_LOAD_TIMEOUT_MS = 20_000;

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

    // SELF-HOSTED WEIGHTS. blazeface.load() with no modelUrl fetches from
    // tfhub.dev, which is a third-party host this app does not control and
    // cannot guarantee reachability of — on a phone on 4G in India it was slow
    // enough to blow the load timeout, and the Report tab fell back to "face
    // blurring could not run" on a photo with a person in it.
    //
    // The model is 466 KB total. It now ships from the same origin that just
    // served the page, so if the app loads, the model loads. Same treatment
    // the dashcam detector already gets (public/models/pothole-yolov8n.onnx).
    //
    // The CDN stays as a fallback for the case where the local files are
    // missing (a partial deploy), because a remote model beats no model.
    try {
      modelCache = await blazeface.load({ modelUrl: MODEL_URL });
    } catch (err) {
      console.warn("[tfjs-redact] self-hosted model failed, trying the CDN:", err);
      modelCache = await blazeface.load();
    }
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
 * Source dimensions, whichever element kind we were handed.
 */
function sizeOf(
  src: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement
): { w: number; h: number } {
  if (src instanceof HTMLImageElement) return { w: src.naturalWidth, h: src.naturalHeight };
  if (src instanceof HTMLVideoElement) return { w: src.videoWidth, h: src.videoHeight };
  return { w: src.width, h: src.height };
}

/** blazeface returns tensors or plain arrays depending on the build. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pair(v: any): [number, number] {
  const a = Array.isArray(v) ? v : v?.arraySync?.() ?? [0, 0];
  return [Number(a[0]) || 0, Number(a[1]) || 0];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function scoreOf(p: any): number | null {
  const raw = Array.isArray(p?.probability)
    ? p.probability[0]
    : typeof p?.probability === "number"
      ? p.probability
      : p?.probability?.arraySync?.()?.[0];
  return typeof raw === "number" ? raw : null;
}

/**
 * A detection score below which a box is discarded.
 *
 * Deliberately permissive. An earlier version used 0.6 to cut cosmetic false
 * positives (gravel read as a face) and that was the wrong trade for this
 * product: a spurious blur costs nothing but a missed face is the privacy
 * failure the whole on-device pipeline exists to prevent. This only trims
 * obvious noise; a box with no score at all is always kept.
 */
const MIN_SCORE = 0.25;

/** Total wall-clock budget for tiled passes. Whole-frame runs regardless. */
const DETECT_BUDGET_MS = 6_000;

/**
 * Runs blazeface over a sub-rectangle of the source, returning boxes in SOURCE
 * pixel coordinates.
 *
 * The crop is drawn into a canvas at `upscale`, because that is the entire
 * point of tiling — see detectFacesWithTFJS.
 */
async function runOn(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any,
  src: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement,
  rx: number,
  ry: number,
  rw: number,
  rh: number
): Promise<BlurRegion[]> {
  // Blazeface's input is 128x128. Feeding it a crop at ~256px means a face
  // occupying 6% of the frame arrives ~4x larger than it would whole-frame.
  const target = 256;
  const scale = target / Math.max(rw, rh);
  const cw = Math.max(1, Math.round(rw * scale));
  const ch = Math.max(1, Math.round(rh * scale));

  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];
  ctx.drawImage(src, rx, ry, rw, rh, 0, 0, cw, ch);

  const predictions: unknown[] = await model.estimateFaces(canvas, false);
  const out: BlurRegion[] = [];
  for (const p of predictions) {
    const score = scoreOf(p);
    if (score !== null && score < MIN_SCORE) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [x1, y1] = pair((p as any).topLeft);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [x2, y2] = pair((p as any).bottomRight);
    out.push({
      x: rx + x1 / scale,
      y: ry + y1 / scale,
      w: (x2 - x1) / scale,
      h: (y2 - y1) / scale,
    });
  }
  return out;
}

/** Fraction of the smaller box covered by the intersection. */
function overlaps(a: BlurRegion, b: BlurRegion): boolean {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  if (inter <= 0) return false;
  return inter / Math.min(a.w * a.h, b.w * b.h) > 0.3;
}

/** Union overlapping boxes so one face found in two tiles is blurred once. */
function merge(boxes: BlurRegion[]): BlurRegion[] {
  const out: BlurRegion[] = [];
  for (const b of boxes) {
    if (b.w <= 1 || b.h <= 1) continue;
    const hit = out.find((o) => overlaps(o, b));
    if (!hit) {
      out.push({ ...b });
      continue;
    }
    const x = Math.min(hit.x, b.x);
    const y = Math.min(hit.y, b.y);
    hit.w = Math.max(hit.x + hit.w, b.x + b.w) - x;
    hit.h = Math.max(hit.y + hit.h, b.y + b.h) - y;
    hit.x = x;
    hit.y = y;
  }
  return out;
}

/**
 * Face boxes in SOURCE pixel coordinates, ready for redactRegion() in imaging.ts.
 *
 * TILED, and that is the whole fix. blazeface resizes whatever you give it to
 * 128x128 before inference, so detection is a function of how much of the FRAME
 * a face occupies, not how many pixels it has. A pothole photo is typically a
 * wide shot of a road with a person standing in it: their head might be 60px in
 * a 1080px-wide image, which is ~7px after the resize, and blazeface simply
 * never sees it. A whole-frame pass reported "0 face(s)" on a photo with a
 * clearly identifiable person in it — and the complaint email then told a
 * municipal body the photo had been redacted.
 *
 * So the frame is scanned whole (cheap, catches near-camera faces) and then in
 * overlapping tiles, each drawn at ~256px so a small face fills enough of the
 * input to survive the resize. Boxes are mapped back and unioned, so a face
 * caught in two tiles is blurred once.
 *
 * Bounded by DETECT_BUDGET_MS: on a CPU backend this is ~10 inferences, and a
 * citizen waiting to file must not be held indefinitely. The whole-frame pass
 * always runs, so exceeding the budget degrades to the old behaviour rather
 * than to nothing.
 */
export async function detectFacesWithTFJS(
  source: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement
): Promise<TFJSRedactResult> {
  try {
    const model = await loadModel();
    const tf = await import("@tensorflow/tfjs");
    const backend = tf.getBackend();

    const { w, h } = sizeOf(source);
    if (!w || !h) return { regions: [], supported: false };

    const found: BlurRegion[] = await runOn(model, source, 0, 0, w, h);

    // 3x3 with 25% overlap, so a face on a tile seam is still whole somewhere.
    const started = Date.now();
    const COLS = 3;
    const ROWS = 3;
    const tw = w / COLS;
    const th = h / ROWS;
    const ox = tw * 0.25;
    const oy = th * 0.25;

    outer: for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (Date.now() - started > DETECT_BUDGET_MS) {
          console.warn("[tfjs-redact] tiled pass hit its time budget; using what was found");
          break outer;
        }
        const rx = Math.max(0, c * tw - ox);
        const ry = Math.max(0, r * th - oy);
        const rw = Math.min(w - rx, tw + ox * 2);
        const rh = Math.min(h - ry, th + oy * 2);
        if (rw < 16 || rh < 16) continue;
        found.push(...(await runOn(model, source, rx, ry, rw, rh)));
      }
    }

    return { regions: merge(found), supported: true, backend };
  } catch (err) {
    console.warn("[tfjs-redact] blazeface failed, falling back to manual blur:", err);
    return { regions: [], supported: false };
  }
}
