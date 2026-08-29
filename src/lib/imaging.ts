"use client";

/**
 * ON-DEVICE IMAGE PIPELINE
 *
 * Downscaling, EXIF stripping, perceptual hashing and the redaction itself all
 * run in the browser. One step does not: locating the faces and number plates.
 * There is no on-device detector any more — `rasterizeForDetection` makes a
 * downscaled, EXIF-stripped frame that `/api/analyze-image` sends to Gemini,
 * which returns the boxes (alongside category + severity, one call). That frame
 * is the only thing that leaves the device un-redacted. The original `File`
 * never leaves, and only the redacted `dataUrl` from `processImage` is stored,
 * attached to a complaint email, or posted publicly.
 *
 * Under DPDP a pedestrian who walks through a pothole photo never made their
 * face publicly available, so the §3(c)(ii) exemption does not cover them.
 * Substantive obligations bite 13 May 2027; penalties reach ₹250 crore. Hence
 * the redaction is mandatory: if detection cannot run, the caller blocks filing
 * until the user has manually covered faces/plates and confirmed.
 */

export interface ProcessedImage {
  /** Redacted, downscaled JPEG data URL. The ONLY version that leaves the device. */
  dataUrl: string;
  width: number;
  height: number;
  /** Perceptual hash (64-bit as hex) for duplicate detection. */
  aHash: string;
  facesFound: number;
  platesFound: number;
  /**
   * True when automatic detection could not run (offline / unconfigured /
   * error). The frame may still contain faces or plates — the caller must make
   * the user review it manually before filing.
   */
  manualReviewRequired: boolean;
  bytes: number;
  /**
   * Auto-detected boxes, kept so a later tap-to-blur can re-render WITHOUT
   * calling the detector again — re-detecting on every tap would re-spend Gemini
   * quota and re-classify the photo.
   */
  faceRegions: BlurRegion[];
  plateRegions: BlurRegion[];
}

const MAX_EDGE = 1280;

/** Blur regions in the coordinate space of the downscaled frame (see MAX_EDGE). */
export interface BlurRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export async function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Could not decode image"));
      img.src = url;
    });
    return img;
  } finally {
    // Revoke on the next tick so decode has definitely finished.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function fitToCanvas(img: HTMLImageElement): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
} {
  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  // Drawing to a canvas and re-encoding drops all EXIF metadata.
  ctx.drawImage(img, 0, 0, w, h);
  return { canvas, ctx, w, h };
}

export interface RasterFrame {
  /** Downscaled, EXIF-stripped, NOT redacted. Only used for detection. */
  dataUrl: string;
  width: number;
  height: number;
}

/**
 * Produce the frame sent to `/api/analyze-image` for detection. Un-redacted by
 * necessity — you cannot box a face that is already covered — but downscaled,
 * stripped of metadata, and never stored.
 */
export async function rasterizeForDetection(file: File): Promise<RasterFrame> {
  const img = await loadImage(file);
  const { canvas, w, h } = fitToCanvas(img);
  return { dataUrl: canvas.toDataURL("image/jpeg", 0.82), width: w, height: h };
}

/** How a region is obscured. `"solid"` = opaque box; `"pixelate"` = mosaic. */
export type FillMode = "pixelate" | "solid";

/**
 * Faces and number plates are covered with an opaque box — a true redaction, not
 * a mosaic. Pixelation still leaks the silhouette, skin tone and rough
 * expression; a civic report going to a government office and a public feed
 * should carry none of that. `"pixelate"` remains available for callers that
 * want to keep scene context.
 */
export const FACE_FILL_MODE: FillMode = "solid";

function paddedRect(ctx: CanvasRenderingContext2D, r: BlurRegion) {
  const x = Math.max(0, Math.floor(r.x));
  const y = Math.max(0, Math.floor(r.y));
  const w = Math.max(1, Math.floor(r.w));
  const h = Math.max(1, Math.floor(r.h));
  // Pad slightly — detector boxes tend to clip hairlines, chins and plate edges.
  const pad = Math.round(Math.max(w, h) * 0.18);
  const px = Math.max(0, x - pad);
  const py = Math.max(0, y - pad);
  const pw = Math.min(ctx.canvas.width - px, w + pad * 2);
  const ph = Math.min(ctx.canvas.height - py, h + pad * 2);
  return { px, py, pw, ph };
}

/** Obscure a region irreversibly — pixelation or an opaque fill, never a blur. */
function redactRegion(ctx: CanvasRenderingContext2D, r: BlurRegion, mode: FillMode) {
  const { px, py, pw, ph } = paddedRect(ctx, r);
  if (pw <= 0 || ph <= 0) return;

  if (mode === "solid") {
    ctx.save();
    ctx.fillStyle = "#111";
    ctx.fillRect(px, py, pw, ph);
    ctx.restore();
    return;
  }

  const data = ctx.getImageData(px, py, pw, ph);
  const block = Math.max(6, Math.floor(Math.max(pw, ph) / 6));

  for (let by = 0; by < ph; by += block) {
    for (let bx = 0; bx < pw; bx += block) {
      let r0 = 0, g0 = 0, b0 = 0, n = 0;
      for (let yy = by; yy < Math.min(by + block, ph); yy++) {
        for (let xx = bx; xx < Math.min(bx + block, pw); xx++) {
          const i = (yy * pw + xx) * 4;
          r0 += data.data[i];
          g0 += data.data[i + 1];
          b0 += data.data[i + 2];
          n++;
        }
      }
      if (!n) continue;
      r0 /= n; g0 /= n; b0 /= n;
      for (let yy = by; yy < Math.min(by + block, ph); yy++) {
        for (let xx = bx; xx < Math.min(bx + block, pw); xx++) {
          const i = (yy * pw + xx) * 4;
          data.data[i] = r0;
          data.data[i + 1] = g0;
          data.data[i + 2] = b0;
        }
      }
    }
  }
  ctx.putImageData(data, px, py);
}

/**
 * Average-hash. Robust to compression and brightness, NOT to viewpoint change —
 * the limitation to remember for dedup: two people shooting the same pothole
 * from different angles will not match on this alone, so geo proximity does the
 * heavy lifting and this only confirms.
 */
function averageHash(ctx: CanvasRenderingContext2D, w: number, h: number): string {
  const S = 8;
  const tmp = document.createElement("canvas");
  tmp.width = S;
  tmp.height = S;
  const tctx = tmp.getContext("2d")!;
  tctx.drawImage(ctx.canvas, 0, 0, w, h, 0, 0, S, S);

  const d = tctx.getImageData(0, 0, S, S).data;
  const grey: number[] = [];
  for (let i = 0; i < d.length; i += 4) {
    grey.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
  }
  const mean = grey.reduce((a, b) => a + b, 0) / grey.length;

  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    let nib = 0;
    for (let j = 0; j < 4; j++) if (grey[i + j] > mean) nib |= 1 << (3 - j);
    hex += nib.toString(16);
  }
  return hex;
}

export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      dist += x & 1;
      x >>= 1;
    }
  }
  return dist;
}

export interface RedactionInput {
  /** Face boxes, in downscaled-frame coordinates (from `llmAnalyze`). */
  faceRegions: BlurRegion[];
  /** Number-plate boxes, same coordinate space. */
  plateRegions: BlurRegion[];
  /** Regions the user tapped to cover. Same coordinate space. */
  manualRegions?: BlurRegion[];
  /** false when detection could not run — surfaces as `manualReviewRequired`. */
  detectionOk: boolean;
}

/**
 * Redact and re-encode a photo on-device from regions the caller already has
 * (via `rasterizeForDetection` + `/api/analyze-image`, then any manual taps).
 * This never touches the network and never runs a model — a tap-to-blur
 * re-render just calls it again with one more region.
 *
 * Faces, plates and manual taps are all covered with an opaque box (see
 * FACE_FILL_MODE) — a true redaction, not a mosaic.
 */
export async function processImage(
  file: File,
  input: RedactionInput
): Promise<ProcessedImage> {
  const img = await loadImage(file);
  const { canvas, ctx, w, h } = fitToCanvas(img);

  for (const r of input.faceRegions) redactRegion(ctx, r, FACE_FILL_MODE);
  for (const r of input.plateRegions) redactRegion(ctx, r, "solid");
  for (const r of input.manualRegions ?? []) redactRegion(ctx, r, "solid");

  const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
  const aHash = averageHash(ctx, w, h);

  return {
    dataUrl,
    width: w,
    height: h,
    aHash,
    facesFound: input.faceRegions.length,
    platesFound: input.plateRegions.length,
    manualReviewRequired: !input.detectionOk,
    bytes: Math.round((dataUrl.length * 3) / 4),
    faceRegions: input.faceRegions,
    plateRegions: input.plateRegions,
  };
}

/**
 * Whether a processed image is cleared to file. Pure, so `verify-guards.ts` can
 * exercise the refusal without a browser: detection must have run, or the user
 * must have ticked the manual-review confirmation.
 */
export function redactionGate(
  image: Pick<ProcessedImage, "manualReviewRequired">,
  manualCleared: boolean
): boolean {
  return !image.manualReviewRequired || manualCleared;
}
