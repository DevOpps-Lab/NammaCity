"use client";

/**
 * DASHCAM POTHOLE DETECTION
 *
 * Runs a purpose-trained YOLOv8n pothole model in the browser via
 * onnxruntime-web. 13MB, served from our own /public — no API key, no CDN, no
 * per-frame server round trip.
 *
 * WHY NOT A HIGHER-LEVEL SDK: two previous attempts failed in production and
 * both are worth remembering.
 *  - Roboflow's inferencejs: every API key/model-id pair returned 401/404 from
 *    Roboflow's own servers.
 *  - transformers.js zero-shot (OWL-ViT): the q4f16 export crashed
 *    onnxruntime's graph optimizer (SimplifiedLayerNormFusion /
 *    InsertedPrecisionFreeCast) and the q8 export hit an unimplemented
 *    Cast(13) kernel. It was also a ViT-B/32 + text encoder at ~1-3s/frame,
 *    far too slow for live video regardless.
 * Driving onnxruntime directly against a plain, standard YOLOv8 graph avoids
 * that whole class of exotic-quantization/graph-fusion failure.
 *
 * MODEL CHOICE IS MEASURED, NOT ASSUMED. Four candidate pothole models were
 * benchmarked offline on the same held-out set (taroii/pothole-detection test
 * split, 20 known-pothole + 15 known-clean images — a different dataset than
 * any of them trained on, so these are cross-dataset numbers). At conf 0.25:
 *   subhodeepmoitra    13MB  recall 90%  false-pos  7%   <- shipped
 *   peterhdd           45MB  recall 75%  false-pos  7%
 *   seanjudelyons      13MB  recall 50%  false-pos 33%
 *   vinothvikas (RDD)  45MB  recall  0%  false-pos  7%
 * The shipped model beats the others at every threshold tested, for the same
 * size as the worst of them. Do not swap it without re-running that benchmark.
 *
 * Per-frame recall still understates live performance: a pothole stays in view
 * for seconds, so it gets several independent chances. Residual false positives
 * are caught by the human review step before anything is filed.
 *
 * SPEED: measured 597ms/frame on single-threaded wasm — under 2fps, so we try
 * WebGPU first, where this class of model typically runs an order of magnitude
 * faster. WebGPU cannot be verified outside a browser, so it is strictly an
 * optimistic upgrade: session creation AND a warmup inference must both
 * succeed, otherwise we fall back to the wasm path that IS verified
 * (scripts/verify-dashcam-model.mjs). Worst case we land on known-good.
 */

import type { InferenceSession } from "onnxruntime-web";
import { filterToRoi, roiBounds, type Roi } from "@/lib/roi";

export interface DashcamDetection {
  /** Top-left based, in the same pixel space as the source canvas. */
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  classLabel: string;
}

export interface DetectorProgress {
  status?: string;
  /** 0-100, or null while indeterminate. */
  progress?: number;
}

/** The ONNX graph has a fixed 640x640 input. */
const INPUT_SIZE = 640;
/** YOLOv8-seg head: 4 box + 1 class + 32 mask coefficients = 37 channels. */
const NUM_MASK_COEFFS = 32;
const MODEL_URL = "/models/pothole-yolov8n.onnx";
const NMS_IOU_THRESHOLD = 0.45;

/**
 * Whole frame by default, with an opt-out.
 *
 * An earlier version cropped to the lower 45% unconditionally, and that was
 * wrong: a close-up video of a damaged surface has the defect anywhere in
 * frame, and the crop threw half of it away. The whole frame is still the
 * default for that reason.
 *
 * But this comment used to go on to claim the tree/sky false positives "turned
 * out to be caused by the feedback-loop bug (inference running on an
 * already-annotated canvas) and by a weak model, both of which are now fixed at
 * the source." THAT IS NOT TRUE, and a later dry run caught it. Re-measured on
 * clean frames decoded straight from video — no annotation feedback possible —
 * the highway clip still produced 8 boxes over 15% of the frame, the largest
 * 35.1% at confidence 0.50, all sitting on the left tree line. The bug fix was
 * real; it just was not the whole cause.
 *
 * The answer is neither "always crop" nor "never crop": see `roi` in
 * DetectOptions, which the user aims and can switch off for close-ups.
 *
 * 0.25 is the measured 90%-recall / 7%-false-positive point. Recall is
 * deliberately favoured over precision because a captured frame still has to
 * pass independent Gemini classification and human confirmation in ReportTab
 * before anything is filed — a missed pothole is unrecoverable, a false one
 * costs a glance. Distant potholes in wide footage also score low, so a
 * stricter floor loses exactly the cases this mode exists to catch.
 */
export const CONF_THRESHOLD = 0.25;

/** Bounds for the UI sensitivity slider. */
export const CONF_MIN = 0.15;
export const CONF_MAX = 0.6;

let sessionPromise: Promise<InferenceSession> | null = null;

/**
 * Reusable scratch canvas for letterboxing. Allocated once — a per-frame
 * 640x640 canvas would churn the GC at 4 inferences/second.
 */
let scratch: HTMLCanvasElement | null = null;
/** Holds the ROI crop for the remote path — see cropTo(). */
let cropScratch: HTMLCanvasElement | null = null;
let scratchCtx: CanvasRenderingContext2D | null = null;
let inputBuffer: Float32Array | null = null;

/**
 * Loads (or returns the already-loading/loaded) session. Safe to call from
 * multiple places — callers share the same in-flight load.
 */
export function loadDetector(onProgress?: (info: DetectorProgress) => void): Promise<InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const ort = await import("onnxruntime-web");

      // Single-threaded deliberately: multi-threaded WASM needs
      // SharedArrayBuffer, which needs COOP/COEP cross-origin isolation, which
      // would break the external map tiles the Map tab loads. Not worth it.
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.simd = true;

      // Fetch the weights ourselves rather than handing ORT the URL, so the
      // download can be reported as real progress instead of a frozen screen.
      const buffer = await fetchWithProgress(MODEL_URL, onProgress);
      onProgress?.({ status: "initializing" });

      const create = (ep: "webgpu" | "wasm") =>
        ort.InferenceSession.create(buffer, {
          executionProviders: [ep],
          graphOptimizationLevel: "all",
        });

      /**
       * A session can be created successfully and still fail on first run
       * (this is exactly how the previous OWL-ViT attempt failed in
       * production), so a candidate EP only counts as working once it has
       * actually produced output. The warmup doubles as JIT priming, keeping
       * the stall off the citizen's first frames.
       */
      const warmup = async (s: InferenceSession) => {
        const plane = INPUT_SIZE * INPUT_SIZE;
        await s.run({
          [s.inputNames[0]]: new ort.Tensor(
            "float32",
            new Float32Array(3 * plane).fill(114 / 255),
            [1, 3, INPUT_SIZE, INPUT_SIZE]
          ),
        });
        return s;
      };

      // Which EP wins now decides whether scanning a clip takes ~12s or ~70s,
      // so make it loud rather than leaving it to be inferred from feel.
      try {
        const s = await warmup(await create("webgpu"));
        console.info("[dashcam-detect] execution provider: webgpu (fast path)");
        return s;
      } catch (err) {
        console.info("[dashcam-detect] WebGPU unavailable, falling back to wasm (slower scan):", err);
        const s = await warmup(await create("wasm"));
        console.info("[dashcam-detect] execution provider: wasm");
        return s;
      }
    })().catch((err) => {
      // Let the next call retry instead of permanently caching a failure.
      sessionPromise = null;
      throw err;
    });
  }
  return sessionPromise;
}

async function fetchWithProgress(
  url: string,
  onProgress?: (info: DetectorProgress) => void
): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch model: ${res.status} ${res.statusText}`);

  const total = Number(res.headers.get("content-length") ?? 0);
  // No body reader or unknown length -> just take the buffer, report nothing.
  if (!res.body || !total) {
    onProgress?.({ status: "download" });
    return await res.arrayBuffer();
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.({ status: "download", progress: (received / total) * 100 });
  }

  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out.buffer;
}

interface SourceRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

interface Letterbox {
  scale: number;
  padX: number;
  padY: number;
  /** Origin of the analysed rect in the source frame, added back on decode. */
  sx: number;
  sy: number;
}

/**
 * Draws the given rect of the frame into a 640x640 letterbox (aspect preserved,
 * grey padding) and fills the CHW float32 input tensor. Letterboxing rather
 * than stretching matches how the model was trained — a plain stretch would
 * distort 16:9 dashcam footage.
 *
 * Taking a rect rather than always the whole canvas is what makes the
 * second, zoomed-in pass possible (see detectPotholes).
 */
function preprocess(
  source: HTMLCanvasElement,
  rect: SourceRect
): { data: Float32Array; lb: Letterbox } {
  if (!scratch) {
    scratch = document.createElement("canvas");
    scratch.width = INPUT_SIZE;
    scratch.height = INPUT_SIZE;
    scratchCtx = scratch.getContext("2d", { willReadFrequently: true });
  }
  const ctx = scratchCtx;
  if (!ctx) throw new Error("Could not acquire a 2D context for preprocessing.");

  const scale = Math.min(INPUT_SIZE / rect.sw, INPUT_SIZE / rect.sh);
  const nw = Math.round(rect.sw * scale);
  const nh = Math.round(rect.sh * scale);
  const padX = Math.floor((INPUT_SIZE - nw) / 2);
  const padY = Math.floor((INPUT_SIZE - nh) / 2);

  ctx.fillStyle = "rgb(114,114,114)";
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  ctx.drawImage(source, rect.sx, rect.sy, rect.sw, rect.sh, padX, padY, nw, nh);

  const { data: rgba } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  const plane = INPUT_SIZE * INPUT_SIZE;
  if (!inputBuffer) inputBuffer = new Float32Array(3 * plane);
  const f = inputBuffer;
  // RGBA HWC uint8 -> RGB CHW float32, scaled to 0..1. The model's
  // preprocessor_config has do_normalize false, so /255 is the whole story.
  for (let i = 0; i < plane; i++) {
    f[i] = rgba[i * 4] / 255;
    f[plane + i] = rgba[i * 4 + 1] / 255;
    f[2 * plane + i] = rgba[i * 4 + 2] / 255;
  }
  return { data: f, lb: { scale, padX, padY, sx: rect.sx, sy: rect.sy } };
}

function iou(a: DashcamDetection, b: DashcamDetection): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - inter;
  return union <= 0 ? 0 : inter / union;
}

/** Greedy non-maximum suppression — one box per pothole, not twenty. */
function nms(boxes: DashcamDetection[]): DashcamDetection[] {
  const sorted = [...boxes].sort((p, q) => q.confidence - p.confidence);
  const keep: DashcamDetection[] = [];
  for (const b of sorted) {
    if (keep.every((k) => iou(k, b) < NMS_IOU_THRESHOLD)) keep.push(b);
  }
  return keep;
}

/**
 * Decodes output0, shape [1, 4+numClasses+32, 8400], channel-major: value c of
 * anchor i lives at `c * 8400 + i`, NOT `i * channels + c`. Boxes come out in
 * 640-space centre/size form, so each is converted to top-left and mapped back
 * through the letterbox into source-canvas pixels.
 *
 * Verified against a composited 1280x720 frame with a pothole at a known
 * position (padY 140, non-zero — the square test images never exercised
 * padding): every decoded centre landed inside the ground-truth region.
 */
function decode(
  data: Float32Array,
  channels: number,
  anchors: number,
  lb: Letterbox,
  threshold: number
): DashcamDetection[] {
  const numClasses = channels - 4 - NUM_MASK_COEFFS;
  const raw: DashcamDetection[] = [];

  for (let i = 0; i < anchors; i++) {
    let best = 0;
    for (let c = 0; c < numClasses; c++) {
      const s = data[(4 + c) * anchors + i];
      if (s > best) best = s;
    }
    if (best < threshold) continue;

    const cx = data[i];
    const cy = data[anchors + i];
    const w = data[2 * anchors + i];
    const h = data[3 * anchors + i];

    // Letterbox is undone first, then the rect origin is added back, so both
    // the whole-frame pass and the zoomed crop land in the same coordinate
    // space and can be NMS'd against each other by the caller.
    raw.push({
      x: (cx - w / 2 - lb.padX) / lb.scale + lb.sx,
      y: (cy - h / 2 - lb.padY) / lb.scale + lb.sy,
      width: w / lb.scale,
      height: h / lb.scale,
      confidence: best,
      classLabel: "pothole",
    });
  }
  // NMS is deliberately NOT applied here — detectPotholes unions the passes
  // and suppresses across the combined set, otherwise the same pothole found
  // by both passes would survive twice.
  return raw;
}

/**
 * The zoomed second pass: the road ahead in a forward-facing frame.
 *
 * Wide dashcam footage is the failing case precisely because the whole frame
 * gets squeezed into 640px, leaving a distant pothole only a handful of pixels.
 * Analysing this sub-rect as well gives it roughly double the linear
 * resolution. Measured on a composited 1280x720 frame, the same pothole scored
 * 0.374 whole-frame and 0.551 cropped.
 */
const ZOOM_RECT = { left: 0.1, right: 0.9, top: 0.4, bottom: 1.0 };

/** Below this width there is no detail to recover, so the zoom pass is skipped. */
const ZOOM_MIN_WIDTH = 640;
/** Near-square frames are close-ups, not road-ahead views — nothing to zoom into. */
const ZOOM_MIN_ASPECT = 1.2;

export interface DetectOptions {
  /** Confidence floor. Defaults to CONF_THRESHOLD; the UI slider overrides it. */
  threshold?: number;
  /**
   * Road-ahead trapezoid. When set it REPLACES the passes below rather than
   * adding to them — the point is to stop looking at the tree line, and a
   * whole-frame pass unioned in would put every tree box straight back. Null
   * (the default) keeps the original two-pass behaviour exactly, which is what
   * close-up footage needs.
   */
  roi?: Roi | null;
}

/**
 * Runs detection on the given canvas and returns pothole boxes in that canvas's
 * pixel space. Returns [] rather than throwing, so a transient failure never
 * kills the caller's scan loop.
 *
 * WITHOUT AN ROI — two passes, unioned: the whole frame plus a zoomed
 * road-ahead crop. Additive by design; an earlier version *replaced*
 * whole-frame inference with a fixed crop and silently broke close-up videos,
 * where the defect sat in the discarded region.
 *
 * WITH AN ROI — one pass over the trapezoid's bounding rect, then a filter
 * dropping boxes whose centre lands outside the trapezoid itself. This is a
 * replacement, and that is the user's explicit choice made visible: the wedge
 * is drawn on the canvas, so what they see is exactly what the model sees.
 * Cropping also raises the road's share of the 640px input, so the ROI pass
 * inherits the zoom pass's resolution advantage for free.
 */
export async function detectPotholes(
  source: HTMLCanvasElement,
  { threshold = CONF_THRESHOLD, roi = null }: DetectOptions = {}
): Promise<DashcamDetection[]> {
  if (!source.width || !source.height) return [];
  try {
    const session = await loadDetector();
    const ort = await import("onnxruntime-web");

    const rects: SourceRect[] = roi
      ? [roiBounds(roi, source.width, source.height)]
      : [{ sx: 0, sy: 0, sw: source.width, sh: source.height }];
    if (
      !roi &&
      source.width >= ZOOM_MIN_WIDTH &&
      source.width / source.height >= ZOOM_MIN_ASPECT
    ) {
      const sx = Math.round(source.width * ZOOM_RECT.left);
      const sy = Math.round(source.height * ZOOM_RECT.top);
      rects.push({
        sx,
        sy,
        sw: Math.round(source.width * ZOOM_RECT.right) - sx,
        sh: Math.round(source.height * ZOOM_RECT.bottom) - sy,
      });
    }

    const found: DashcamDetection[] = [];
    for (const rect of rects) {
      const { data, lb } = preprocess(source, rect);
      const results = await session.run({
        [session.inputNames[0]]: new ort.Tensor("float32", data, [1, 3, INPUT_SIZE, INPUT_SIZE]),
      });
      // output1 is the mask-prototype tensor — instance segmentation data we
      // deliberately ignore, since Dashcam mode only ever draws boxes.
      const out = results[session.outputNames[0]];
      const [, channels, anchors] = out.dims as [number, number, number];
      found.push(...decode(out.data as Float32Array, channels, anchors, lb, threshold));
    }

    // One suppression across the union — the same pothole seen by both passes
    // must collapse to a single box, keeping the higher-scoring one.
    //
    // The ROI filter runs last, on the suppressed set. The rect handed to the
    // model is a rectangle and the ROI is a trapezoid, so its top corners were
    // still analysed — and on wide footage those corners are precisely where
    // the roadside trees are.
    return filterToRoi(roi, source.width, source.height, nms(found));
  } catch (err) {
    console.warn("[dashcam-detect] inference failed:", err);
    return [];
  }
}

// ─────────────────────────────────────────────────────────── remote detector

/**
 * The optional server-side detector (detector/server.py, via
 * /api/dashcam/detect).
 *
 * It exists because the two available models turned out to be COMPLEMENTARY
 * rather than one being better. Benchmarked on three dashcam clips, full-frame
 * detections were 9/0/3 for the in-browser `pothole_yolov8n` and 0/7/11 for the
 * larger `best.pt`: ours wins decisively on phone-shot footage, theirs on the
 * other two. Running both and unioning beats either, and 28 MB of weights is a
 * reasonable thing to ask of a server and an unreasonable thing to ask of a
 * phone on 4G.
 *
 * ALWAYS OPTIONAL. Every failure path returns null so the caller runs the local
 * detector instead. A Dashcam tab that stops working because a Python service
 * restarted would be worse than the one that existed before it.
 */
export async function detectPotholesRemote(
  source: HTMLCanvasElement,
  { threshold = CONF_THRESHOLD, roi = null }: DetectOptions = {}
): Promise<DashcamDetection[] | null> {
  if (!source.width || !source.height) return null;

  try {
    // With an ROI, only the crop is uploaded. Cheaper on mobile data than the
    // whole frame, and it keeps the ROI a single implementation living here
    // rather than a second one in Python that could drift from this one.
    const rect = roi ? roiBounds(roi, source.width, source.height) : null;
    const sent = rect ? cropTo(source, rect) : source;
    if (!sent) return null;

    const blob = await new Promise<Blob | null>((resolve) =>
      sent.toBlob(resolve, "image/jpeg", 0.8)
    );
    if (!blob) return null;

    const form = new FormData();
    form.append("frame", blob, "frame.jpg");
    // The server otherwise runs at its own fixed default and the sensitivity
    // slider silently does nothing whenever this path is selected.
    form.append("conf", String(threshold));

    const res = await fetch("/api/dashcam/detect", { method: "POST", body: form });
    // 503 is the sidecar being down, which is expected and not an error worth
    // shouting about — the caller falls back.
    if (!res.ok) return null;

    const body = (await res.json()) as { available?: boolean; detections?: DashcamDetection[] };
    if (!body.available || !Array.isArray(body.detections)) return null;

    // Boxes come back in the pixel space of the image we POSTed. Without an ROI
    // that is already the source canvas and there is nothing to undo; with one,
    // the crop origin has to be added back — the same correction the local path
    // makes via `lb.sx`/`lb.sy` in decode().
    const mapped = rect
      ? body.detections.map((d) => ({ ...d, x: d.x + rect.sx, y: d.y + rect.sy }))
      : body.detections;

    return filterToRoi(roi, source.width, source.height, mapped);
  } catch {
    return null;
  }
}

/**
 * Copies a sub-rect into a reusable scratch canvas.
 *
 * Separate from `scratch` above, which holds the 640x640 tensor letterbox and
 * would be clobbered mid-flight — both are in play during a single remote
 * frame. Reused rather than allocated per frame: this runs several times a
 * second for the length of a clip.
 */
function cropTo(source: HTMLCanvasElement, rect: SourceRect): HTMLCanvasElement | null {
  if (!cropScratch) cropScratch = document.createElement("canvas");
  if (cropScratch.width !== rect.sw) cropScratch.width = rect.sw;
  if (cropScratch.height !== rect.sh) cropScratch.height = rect.sh;
  const ctx = cropScratch.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(source, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, rect.sw, rect.sh);
  return cropScratch;
}

/** Whether the sidecar is up, so the UI can avoid offering a dead option. */
export async function remoteDetectorAvailable(): Promise<{ available: boolean; models: string[] }> {
  try {
    const res = await fetch("/api/dashcam/detect");
    if (!res.ok) return { available: false, models: [] };
    const body = (await res.json()) as { available?: boolean; models?: string[] };
    return { available: Boolean(body.available), models: body.models ?? [] };
  } catch {
    return { available: false, models: [] };
  }
}
