"use client";

/**
 * DASHCAM POTHOLE DETECTION
 *
 * Runs Hugging Face's zero-shot object detection (OWL-ViT) entirely in the
 * browser via `@huggingface/transformers` — no server round trip per frame,
 * no API key. There is no purpose-built pothole model that plugs into
 * transformers.js the way a trained-model SDK would: every pothole-specific
 * model on the HF Hub is a raw YOLOv8 export with no transformers.js-
 * compatible config. Zero-shot detection sidesteps that entirely — the model
 * is given the text label "pothole" directly instead of being trained on it.
 *
 * Dynamic import + a module-level cached pipeline promise, same shape as the
 * old Roboflow loader: the ~127MB quantized weights must never land in the
 * initial JS chunk, and re-entering the Dashcam tab must not re-download them.
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

export interface DetectorProgress {
  status?: string;
  file?: string;
  /** 0-100. Not always present — some progress events omit it (upstream quirk). */
  progress?: number;
}

const CANDIDATE_LABELS = ["pothole"];
const MODEL_ID = "Xenova/owlvit-base-patch32";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Detector = (image: unknown, labels: string[], options?: unknown) => Promise<any[]>;

let detectorPromise: Promise<Detector> | null = null;

/**
 * Loads (or returns the already-loading/loaded) detector pipeline. Safe to
 * call from multiple places — callers share the same in-flight download.
 */
export function loadDetector(onProgress?: (info: DetectorProgress) => void): Promise<Detector> {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      return (await pipeline("zero-shot-object-detection", MODEL_ID, {
        // q8 (-> model_quantized.onnx) is transformers.js's own documented
        // default dtype for WASM/CPU inference — deliberately NOT q4f16,
        // which hits a known onnxruntime-web graph-fusion bug ("Can't create
        // a session" / SimplifiedLayerNormFusion / InsertedPrecisionFreeCast)
        // confirmed against this exact model in production.
        dtype: "q8",
        progress_callback: (info: DetectorProgress) => onProgress?.(info),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)) as unknown as Detector;
    })().catch((err) => {
      // Let the next call retry instead of permanently caching a failure.
      detectorPromise = null;
      throw err;
    });
  }
  return detectorPromise;
}

/**
 * Runs one zero-shot detection pass on the given canvas and returns pothole
 * matches only, normalized to the same top-left {x,y,width,height} shape the
 * rest of Dashcam mode already expects.
 */
export async function detectPotholes(source: HTMLCanvasElement): Promise<DashcamDetection[]> {
  try {
    const detector = await loadDetector();
    const results = await detector(source, CANDIDATE_LABELS, { threshold: 0.4 });

    return results.map((r) => ({
      x: r.box.xmin,
      y: r.box.ymin,
      width: r.box.xmax - r.box.xmin,
      height: r.box.ymax - r.box.ymin,
      confidence: r.score,
      classLabel: r.label,
    }));
  } catch (err) {
    console.warn("[dashcam-detect] inference failed:", err);
    return [];
  }
}
