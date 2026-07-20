"use client";

/**
 * ON-DEVICE IMAGE PIPELINE
 *
 * Everything here runs in the browser, before anything is uploaded. That
 * ordering is the whole point: under DPDP, the cheapest way to be safe with
 * bystanders' faces and licence plates is for the identifiable data to never
 * reach our systems at all.
 *
 * The §3(c)(ii) "publicly available data" exemption does NOT cover a pedestrian
 * who happens to walk through your pothole photo — they never made their face
 * publicly available. Substantive DPDP obligations bite 13 May 2027; penalties
 * reach ₹250 crore.
 *
 * Re-encoding through a canvas also strips EXIF as a side effect, which is what
 * we want: EXIF often carries device identifiers, and sometimes the owner's
 * name. We read live geolocation separately instead.
 *
 * Face detection uses TensorFlow.js blazeface (tfjs-redact.ts) rather than the
 * browser-native FaceDetector, which is Chromium-only and disabled on many
 * devices. Blazeface is consistent across all modern browsers.
 */

export interface ProcessedImage {
  /** Redacted, downscaled JPEG data URL. The ONLY version that leaves the device. */
  dataUrl: string;
  width: number;
  height: number;
  /** Perceptual hash (64-bit as hex) for duplicate detection. */
  aHash: string;
  facesFound: number;
  /** True when TF.js failed to load or run; user must review manually. */
  manualReviewRequired: boolean;
  bytes: number;
  /** Which TF.js backend ran, for the Agent Trace. */
  detectionBackend?: string;
}

const MAX_EDGE = 1280;

/** Blur regions in source-image pixel coordinates. */
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

/**
 * Face detection via TensorFlow.js blazeface.
 * Falls back gracefully if the model fails to load — the caller receives
 * supported: false and the UI prompts for manual review rather than implying
 * the photo is clean.
 */
async function detectFaces(
  source: HTMLImageElement
): Promise<{ regions: BlurRegion[]; supported: boolean; backend?: string }> {
  const { detectFacesWithTFJS } = await import("./tfjs-redact");
  return detectFacesWithTFJS(source);
}

/** Pixelate a region hard enough to be irreversible — not a reversible blur. */
function redactRegion(
  ctx: CanvasRenderingContext2D,
  r: BlurRegion,
  scale: number
) {
  const x = Math.max(0, Math.floor(r.x * scale));
  const y = Math.max(0, Math.floor(r.y * scale));
  const w = Math.max(1, Math.floor(r.w * scale));
  const h = Math.max(1, Math.floor(r.h * scale));

  // Pad slightly — detector boxes tend to clip hairlines and chins.
  const pad = Math.round(Math.max(w, h) * 0.18);
  const px = Math.max(0, x - pad);
  const py = Math.max(0, y - pad);
  const pw = Math.min(ctx.canvas.width - px, w + pad * 2);
  const ph = Math.min(ctx.canvas.height - py, h + pad * 2);
  if (pw <= 0 || ph <= 0) return;

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
 * which is exactly the limitation to remember for dedup: two people shooting the
 * same pothole from different angles will not match on this alone, so geo
 * proximity does the heavy lifting and this only confirms.
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

export async function processImage(
  file: File,
  extraRegions: BlurRegion[] = []
): Promise<ProcessedImage> {
  const img = await loadImage(file);

  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

  // Drawing to a canvas and re-encoding drops all EXIF metadata.
  ctx.drawImage(img, 0, 0, w, h);

  const { regions, supported, backend } = await detectFaces(img);
  for (const r of regions) redactRegion(ctx, r, scale);
  // Manual regions are already in displayed-canvas coordinates.
  for (const r of extraRegions) redactRegion(ctx, r, 1);

  const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
  const aHash = averageHash(ctx, w, h);

  return {
    dataUrl,
    width: w,
    height: h,
    aHash,
    facesFound: regions.length,
    manualReviewRequired: !supported,
    bytes: Math.round((dataUrl.length * 3) / 4),
    detectionBackend: backend,
  };
}
