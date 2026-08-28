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
 * MODEL CHOICE IS MEASURED ON REAL FOOTAGE. Six candidates were benchmarked
 * against three frames of the user's actual Bangalore dashcam clip, which is
 * the only yardstick that mattered — a close-up pothole benchmark had ranked
 * these almost in reverse and sent two earlier attempts down the wrong path.
 * With tiled inference, frames detected out of 3:
 *   peterhdd (YOLOv8s)   3/3 at 0.64/0.64/0.50, boxes on the road   <- shipped
 *   achopra20            3/3 but boxes on roadside dirt, 44% FP
 *   subhodeepmoitra      1/3 at 0.29
 *   vinothvikas (RDD)    0/3
 *   aarmstrkk (YOLOv8x)  0/24 on a synthetic set, 1766ms/frame
 * Note the shipped model scored WORSE than subhodeepmoitra on close-ups
 * (75% vs 90%) and better here. Do not re-rank these on close-up images.
 *
 * It ships INT8-quantised: 43MB -> 11MB and 1284ms -> 606ms per inference on
 * wasm. That costs a little confidence (0.64 -> 0.51) but more than doubles how
 * many frames fit the scan budget, and frame coverage was the original root
 * cause of missed potholes, so the trade is strongly worth it. At conf 0.30 the
 * quantised model still fires on all three frames.
 *
 * SPEED: 606ms per inference on single-threaded wasm, three tiles per frame, so
 * ~1.8s per analysed frame. WebGPU is tried first and is typically an order of
 * magnitude faster, but cannot be verified outside a browser, so it is strictly
 * an optimistic upgrade: session creation AND a warmup inference must both
 * succeed, otherwise we fall back to the wasm path that IS verified
 * (scripts/verify-dashcam-model.mjs). Worst case we land on known-good.
 */

import type { InferenceSession } from "onnxruntime-web";

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
const MODEL_URL = "/models/road-defect-yolov8s-int8.onnx";
const NMS_IOU_THRESHOLD = 0.45;

/**
 * A YOLOv8-SEG head carries 32 mask-coefficient channels after the class
 * scores (4 box + nc + 32); a plain DETECT head has none (4 box + nc). Getting
 * this wrong is silent and total: assuming 32 on a detect model whose output is
 * [1,5,8400] computes nc = 5-4-32 = -31, the class loop never runs, and every
 * frame returns zero detections. So it is derived from the model's own output
 * count rather than hardcoded — the shipped model is a detect export, the
 * previous one was seg.
 */
function maskCoeffsFor(session: InferenceSession): number {
  return session.outputNames.length >= 2 ? 32 : 0;
}

/**
 * Whole frame, deliberately.
 *
 * An earlier version cropped to the lower 45% as a "road region", on the
 * assumption of a forward-facing dashcam. That assumption is wrong for the
 * footage people actually upload: a close-up video of a damaged surface has the
 * defect anywhere in frame, and the crop threw half of it away — the tab
 * detected nothing at all on exactly the clearest test video. The tree/sky
 * false positives that motivated the crop turned out to be caused by the
 * feedback-loop bug (inference running on an already-annotated canvas) and by a
 * weak model, both of which are now fixed at the source.
 *
 * 0.30 is the highest floor that still fires on all three frames of the user's
 * real dashcam clip (0.51 / 0.51 / 0.31) while holding false positives at 11%.
 * At 0.35 the third frame drops out entirely, so there is no headroom above
 * this. Recall is favoured over precision anyway: a captured frame still faces
 * independent Gemini classification and human confirmation in ReportTab before
 * anything is filed, so a missed defect is unrecoverable while a false one
 * costs a glance.
 */
export const CONF_THRESHOLD = 0.3;

/** Bounds for the UI sensitivity slider. */
export const CONF_MIN = 0.15;
export const CONF_MAX = 0.6;

let sessionPromise: Promise<InferenceSession> | null = null;

/**
 * Reusable scratch canvas for letterboxing. Allocated once — a per-frame
 * 640x640 canvas would churn the GC at 4 inferences/second.
 */
let scratch: HTMLCanvasElement | null = null;
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
  threshold: number,
  numMaskCoeffs: number
): DashcamDetection[] {
  const numClasses = channels - 4 - numMaskCoeffs;
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
 * TILED INFERENCE (SAHI-style), which is what finally made real dashcam footage
 * work. Whole-frame inference on a 1511px-wide frame squeezes it to 640px, and
 * a mid-distance road defect ends up a couple of dozen pixels across — below
 * what the model can resolve. Each tile is instead fed at roughly the scale the
 * model was trained on.
 *
 * The geometry is measured, not guessed. On three frames of the user's own
 * Bangalore dashcam clip:
 *   whole frame only        -> 0/3 frames, nothing at any threshold
 *   3 tiles, bottom row     -> 3/3 frames at 0.51 / 0.51 / 0.31
 *   full + 3x2 grid (7)     -> identical detections, at more than twice the cost
 * Both hits sat in the bottom row, and adding the whole-frame pass or the upper
 * row changed nothing, so this ships the cheapest configuration that found
 * everything the expensive one did.
 *
 * Tile HEIGHT is the sensitive parameter: the band is split so tiles are short
 * (~2.7x zoom). Taller tiles covering the same area detected nothing — that is
 * the difference between this and the earlier two-pass attempt.
 */
const ROAD_BAND_TOP = 0.4;
const TILE_COLS = 3;
const TILE_OVERLAP = 0.2;
/** Two rows' worth of height, but only the lower row is analysed. */
const TILE_ROW_DIVISOR = 1.8;

/** Below this width tiling recovers nothing, so the frame is analysed whole. */
const TILE_MIN_WIDTH = 900;

/**
 * Overlapping tiles across the lower road band. Overlap matters: a defect
 * straddling a tile seam would otherwise be cut in half and missed by both
 * tiles; the union NMS in detectPotholes collapses the duplicates.
 */
function roadTiles(width: number, height: number): SourceRect[] {
  if (width < TILE_MIN_WIDTH) {
    return [{ sx: 0, sy: 0, sw: width, sh: height }];
  }
  const top = Math.round(height * ROAD_BAND_TOP);
  const bandHeight = height - top;
  const tileW = Math.round(width / (TILE_COLS - (TILE_COLS - 1) * TILE_OVERLAP));
  const tileH = Math.round(bandHeight / TILE_ROW_DIVISOR);
  const sy = Math.min(top + Math.round(tileH * (1 - TILE_OVERLAP)), Math.max(top, height - tileH));

  const rects: SourceRect[] = [];
  for (let c = 0; c < TILE_COLS; c++) {
    const sx = Math.min(Math.round(c * tileW * (1 - TILE_OVERLAP)), Math.max(0, width - tileW));
    rects.push({ sx, sy, sw: Math.min(tileW, width - sx), sh: Math.min(tileH, height - sy) });
  }
  return rects;
}

/** How many inferences one detectPotholes() call costs — for scan budgeting. */
export function passesPerFrame(width: number, height: number): number {
  return roadTiles(width, height).length;
}

export interface DetectOptions {
  /** Confidence floor. Defaults to CONF_THRESHOLD; the UI slider overrides it. */
  threshold?: number;
}

/**
 * Runs detection on the given canvas and returns pothole boxes in that canvas's
 * pixel space. Returns [] rather than throwing, so a transient failure never
 * kills the caller's scan loop.
 *
 * Runs one inference per road tile (see roadTiles) and unions the results
 * through a single NMS, so a defect straddling a tile seam collapses to one box
 * instead of two.
 */
export async function detectPotholes(
  source: HTMLCanvasElement,
  { threshold = CONF_THRESHOLD }: DetectOptions = {}
): Promise<DashcamDetection[]> {
  if (!source.width || !source.height) return [];
  try {
    const session = await loadDetector();
    const ort = await import("onnxruntime-web");

    const numMaskCoeffs = maskCoeffsFor(session);
    const found: DashcamDetection[] = [];
    for (const rect of roadTiles(source.width, source.height)) {
      const { data, lb } = preprocess(source, rect);
      const results = await session.run({
        [session.inputNames[0]]: new ort.Tensor("float32", data, [1, 3, INPUT_SIZE, INPUT_SIZE]),
      });
      // On a seg model output1 is the mask-prototype tensor — segmentation data
      // we deliberately ignore, since Dashcam mode only ever draws boxes.
      const out = results[session.outputNames[0]];
      const [, channels, anchors] = out.dims as [number, number, number];
      found.push(
        ...decode(out.data as Float32Array, channels, anchors, lb, threshold, numMaskCoeffs)
      );
    }

    // One suppression across the union — the same pothole seen by both passes
    // must collapse to a single box, keeping the higher-scoring one.
    return nms(found);
  } catch (err) {
    console.warn("[dashcam-detect] inference failed:", err);
    return [];
  }
}
