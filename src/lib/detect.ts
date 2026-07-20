"use client";

import type { Severity, IssueCategory } from "./types";

/**
 * DEFECT ANALYSIS
 *
 * ⚠ HONEST LABELLING: this is a classical computer-vision heuristic, NOT a
 * trained detector. It computes real statistics from real pixels — it is not a
 * hardcoded constant, and it produces different answers for different photos —
 * but it is a stand-in for the YOLOv8/RDD2022 model that a production build
 * would ship, and the UI says so.
 *
 * Why it's built to under-claim:
 *
 *  - The best published per-class number for potholes on RDD2022 is ~53%
 *    mAP@50 (YOLOv8-PD). Potholes are the WEAKEST class in the benchmark
 *    because the target is small and under-represented in training data.
 *  - Monocular depth is not solved. Published monocular error is an order of
 *    magnitude worse than LiDAR, and the SOTA approaches are video-based with
 *    temporal smoothing precisely because single stills lack the signal.
 *    So severity is ORDINAL ONLY. We never emit a measurement in centimetres.
 *  - Documented confusers are shadows, wet patches, oil stains, manhole covers
 *    and road patches. In rain "potholes may be hidden under puddles or may
 *    resemble puddles" — genuinely ambiguous to humans too. So low-contrast and
 *    highly-specular images are reported as low confidence rather than guessed.
 */

export interface DetectionResult {
  severity: Severity;
  /** 0-1. Deliberately capped — see CONFIDENCE_CEILING. */
  confidence: number;
  /** Fraction of the frame occupied by the candidate defect region. */
  areaFraction: number;
  /** Diagnostics shown in the Agent Trace so the reasoning is inspectable. */
  signals: string[];
  /** True when the image looks like a known confuser rather than a defect. */
  lowConfidence: boolean;
  method: "heuristic-v1";
}

/**
 * No heuristic — and for that matter no published model — earns high confidence
 * on this class. Capping is the honest choice and keeps the UI from implying
 * more certainty than the field supports.
 */
export const CONFIDENCE_CEILING = 0.78;

export function analyseImage(dataUrl: string): Promise<DetectionResult> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(runAnalysis(img));
    img.onerror = () =>
      resolve({
        severity: "medium",
        confidence: 0.2,
        areaFraction: 0,
        signals: ["Image could not be decoded — falling back to manual severity."],
        lowConfidence: true,
        method: "heuristic-v1",
      });
    img.src = dataUrl;
  });
}

function runAnalysis(img: HTMLImageElement): DetectionResult {
  const W = 160;
  const H = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * W));

  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, W, H);
  const { data } = ctx.getImageData(0, 0, W, H);

  const signals: string[] = [];

  // --- luminance + saturation stats ---------------------------------------
  const lum = new Float32Array(W * H);
  let sum = 0;
  let satSum = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    lum[p] = l;
    sum += l;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    satSum += mx === 0 ? 0 : (mx - mn) / mx;
  }
  const mean = sum / lum.length;
  const meanSat = satSum / lum.length;

  let varSum = 0;
  for (let p = 0; p < lum.length; p++) varSum += (lum[p] - mean) ** 2;
  const std = Math.sqrt(varSum / lum.length);

  // --- candidate defect region: connected dark area, biased to lower frame --
  // Road defects sit on the ground plane, so the bottom two-thirds of a
  // handheld photo is where they almost always are. Dark sky or dark buildings
  // in the top third are not potholes.
  const threshold = mean - std * 0.75;
  let darkCount = 0;
  let minX = W, maxX = 0, minY = H, maxY = 0;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (lum[p] >= threshold) continue;
      if (y < H * 0.33) continue; // ignore upper third
      darkCount++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  const areaFraction = darkCount / (W * H);
  const boxW = Math.max(0, maxX - minX);
  const boxH = Math.max(0, maxY - minY);
  const boxFraction = (boxW * boxH) / (W * H);

  signals.push(
    `luminance mean ${mean.toFixed(0)}, contrast σ ${std.toFixed(1)}, saturation ${(meanSat * 100).toFixed(0)}%`
  );
  signals.push(
    `candidate region ${(areaFraction * 100).toFixed(1)}% of frame, bbox ${boxW}×${boxH}px`
  );

  // --- confuser checks -----------------------------------------------------
  let lowConfidence = false;
  let penalty = 0;

  if (std < 22) {
    signals.push("Low contrast — shadow or overcast conditions are hard to separate.");
    penalty += 0.25;
    lowConfidence = true;
  }
  if (meanSat < 0.12 && mean > 150) {
    signals.push("Bright and desaturated — possible wet road or glare.");
    penalty += 0.15;
    lowConfidence = true;
  }
  if (areaFraction < 0.008) {
    signals.push("No significant dark region found — may be intact road.");
    penalty += 0.3;
    lowConfidence = true;
  }
  if (areaFraction > 0.42) {
    signals.push("Dark region dominates the frame — likely shadow, not a defect.");
    penalty += 0.3;
    lowConfidence = true;
  }
  // A tight, filled bbox reads more like a manhole/patch than a pothole.
  if (boxFraction > 0.01 && areaFraction / boxFraction > 0.86) {
    signals.push("Region is near-rectangular — possible manhole cover or road patch.");
    penalty += 0.12;
  }

  // --- ordinal severity ONLY ----------------------------------------------
  const severity: Severity =
    areaFraction > 0.16 ? "large" : areaFraction > 0.05 ? "medium" : "small";

  // Confidence peaks when the dark region is a plausible pothole size.
  const sizeFit = 1 - Math.min(1, Math.abs(areaFraction - 0.12) / 0.22);
  const contrastFit = Math.min(1, std / 55);
  const raw = 0.35 + 0.4 * sizeFit + 0.25 * contrastFit - penalty;
  const confidence = Math.max(0.05, Math.min(CONFIDENCE_CEILING, raw));

  return {
    severity,
    confidence: Number(confidence.toFixed(2)),
    areaFraction,
    signals,
    lowConfidence: lowConfidence || confidence < 0.4,
    method: "heuristic-v1",
  };
}

/** Category still comes from the user — inferring it from pixels is not credible. */
export const CATEGORY_OPTIONS: { value: IssueCategory; label: string; ta: string }[] = [
  { value: "pothole", label: "Pothole", ta: "சாலைக் குழி" },
  { value: "storm_water_drain", label: "Storm water drain", ta: "மழைநீர் வடிகால்" },
  { value: "sewage_overflow", label: "Sewage overflow", ta: "கழிவுநீர் வழிதல்" },
  { value: "garbage", label: "Garbage", ta: "குப்பை" },
  { value: "streetlight", label: "Streetlight", ta: "தெருவிளக்கு" },
  { value: "other", label: "Other", ta: "மற்றவை" },
];
