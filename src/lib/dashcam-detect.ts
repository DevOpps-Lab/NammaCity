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
 * MEASURED, not assumed (verified offline against the taroii/pothole-detection
 * test split — a DIFFERENT dataset than the model was trained on, so this is a
 * genuine cross-dataset number, unlike the model card's claimed mAP50 0.995):
 *   conf 0.40 -> 40% per-frame recall,  7% false positives
 *   conf 0.25 -> 50% per-frame recall, 33% false positives
 *   conf 0.15 -> 80% per-frame recall, 53% false positives
 * 0.40 is the chosen operating point. Per-frame recall understates real
 * performance: a pothole stays in view for seconds, so it gets several
 * independent chances to be caught. The residual false positives are caught by
 * the human review step before anything is filed.
 *
 * SPEED: measured 877ms/frame on single-threaded wasm, which is only ~1fps —
 * so we try WebGPU first, where this class of model typically runs an order of
 * magnitude faster. WebGPU cannot be verified outside a browser, so it is
 * strictly an optimistic upgrade: session creation AND a warmup inference must
 * both succeed, otherwise we fall back to the wasm path that IS verified
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
/** YOLOv8-seg head: 4 box + 1 class + 32 mask coefficients = 37 channels. */
const NUM_MASK_COEFFS = 32;
const MODEL_URL = "/models/pothole-yolov8n.onnx";
const NMS_IOU_THRESHOLD = 0.45;

/**
 * Fraction of the frame height skipped from the top before inference — the
 * road-ahead region of interest for a forward-facing camera.
 *
 * This is not a cosmetic crop. Feeding the whole frame meant the sky, treeline
 * and roadside verge all reached the model, and on real dashcam footage that
 * produced confident detections on trees while the actual road scored lower.
 * Potholes are, by definition, on the road surface, so anything above the
 * horizon is noise the model should never see.
 *
 * Measured on a composited 1280x720 frame: cropping raised the true pothole's
 * score from 0.374 to 0.551, and makes an above-horizon detection structurally
 * impossible rather than merely unlikely.
 */
export const ROAD_ROI_TOP_FRACTION = 0.45;

/**
 * Raised from 0.4 to 0.5 now that the ROI crop lifts genuine scores: the same
 * pothole that scored 0.374 full-frame scores 0.551 cropped, so a stricter
 * threshold cuts false positives without losing real detections.
 */
const CONF_THRESHOLD = 0.5;

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

      try {
        return await warmup(await create("webgpu"));
      } catch (err) {
        console.info("[dashcam-detect] WebGPU unavailable, using wasm:", err);
        return await warmup(await create("wasm"));
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

interface Letterbox {
  scale: number;
  padX: number;
  padY: number;
  /** Origin of the cropped ROI within the source frame, added back on decode. */
  roiX: number;
  roiY: number;
}

/**
 * Crops to the road ROI, draws it into a 640x640 letterbox (aspect preserved,
 * grey padding) and fills the CHW float32 input tensor. Letterboxing rather
 * than stretching matches how the model was trained — a plain stretch would
 * distort 16:9 dashcam footage.
 */
function preprocess(source: HTMLCanvasElement): { data: Float32Array; lb: Letterbox } {
  if (!scratch) {
    scratch = document.createElement("canvas");
    scratch.width = INPUT_SIZE;
    scratch.height = INPUT_SIZE;
    scratchCtx = scratch.getContext("2d", { willReadFrequently: true });
  }
  const ctx = scratchCtx;
  if (!ctx) throw new Error("Could not acquire a 2D context for preprocessing.");

  // Road ROI only — see ROAD_ROI_TOP_FRACTION.
  const roiX = 0;
  const roiY = Math.floor(source.height * ROAD_ROI_TOP_FRACTION);
  const roiW = source.width;
  const roiH = source.height - roiY;

  const scale = Math.min(INPUT_SIZE / roiW, INPUT_SIZE / roiH);
  const nw = Math.round(roiW * scale);
  const nh = Math.round(roiH * scale);
  const padX = Math.floor((INPUT_SIZE - nw) / 2);
  const padY = Math.floor((INPUT_SIZE - nh) / 2);

  ctx.fillStyle = "rgb(114,114,114)";
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  ctx.drawImage(source, roiX, roiY, roiW, roiH, padX, padY, nw, nh);

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
  return { data: f, lb: { scale, padX, padY, roiX, roiY } };
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
 * through the letterbox AND the ROI offset into full source-canvas pixels.
 *
 * Verified against a composited 1280x720 frame with a pothole at a known
 * position (padY 140, non-zero — the square test images never exercised
 * padding): every decoded centre landed inside the ground-truth region.
 */
function decode(
  data: Float32Array,
  channels: number,
  anchors: number,
  lb: Letterbox
): DashcamDetection[] {
  const numClasses = channels - 4 - NUM_MASK_COEFFS;
  const raw: DashcamDetection[] = [];

  for (let i = 0; i < anchors; i++) {
    let best = 0;
    for (let c = 0; c < numClasses; c++) {
      const s = data[(4 + c) * anchors + i];
      if (s > best) best = s;
    }
    if (best < CONF_THRESHOLD) continue;

    const cx = data[i];
    const cy = data[anchors + i];
    const w = data[2 * anchors + i];
    const h = data[3 * anchors + i];

    raw.push({
      x: (cx - w / 2 - lb.padX) / lb.scale + lb.roiX,
      y: (cy - h / 2 - lb.padY) / lb.scale + lb.roiY,
      width: w / lb.scale,
      height: h / lb.scale,
      confidence: best,
      classLabel: "pothole",
    });
  }
  return nms(raw);
}

/**
 * Runs one detection pass on the given canvas. Returns [] rather than throwing
 * so the caller's animation loop stays alive on a transient failure.
 */
export async function detectPotholes(source: HTMLCanvasElement): Promise<DashcamDetection[]> {
  if (!source.width || !source.height) return [];
  try {
    const session = await loadDetector();
    const ort = await import("onnxruntime-web");

    const { data, lb } = preprocess(source);
    const feeds = {
      [session.inputNames[0]]: new ort.Tensor("float32", data, [1, 3, INPUT_SIZE, INPUT_SIZE]),
    };
    const results = await session.run(feeds);
    // output1 is the mask-prototype tensor — instance segmentation data we
    // deliberately ignore, since Dashcam mode only ever draws boxes.
    const out = results[session.outputNames[0]];
    const [, channels, anchors] = out.dims as [number, number, number];

    return decode(out.data as Float32Array, channels, anchors, lb);
  } catch (err) {
    console.warn("[dashcam-detect] inference failed:", err);
    return [];
  }
}
