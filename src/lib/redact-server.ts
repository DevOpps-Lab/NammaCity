import sharp from "sharp";
import type { FaceBox } from "./vision";

/**
 * SERVER-SIDE FACE REDACTION, for photos that never touched a browser.
 *
 * The app redacts on the device (imaging.ts) from boxes a Gemini call returns,
 * and the original file never leaves the phone — that is the guarantee we
 * prefer. But a photo messaged over WhatsApp arrives as a Twilio media URL: no
 * browser, no canvas, and by then the unredacted original is already on our
 * server. The previous position was to strip EXIF, record `source='whatsapp'`
 * and say plainly that faces were not blurred.
 *
 * Saying it plainly is not the same as it being acceptable. A pothole photo
 * routinely contains whoever is standing in the road, and this pipeline mails
 * that image to a government office and publishes it on an open ledger. DPDP's
 * §3(c)(ii) "publicly available data" exemption does not cover a passer-by who
 * never made their face public. So faces get blurred here too — later and
 * weaker than on-device, but before the photo is stored, mailed or published.
 *
 * Boxes come from the Gemini call the intake ALREADY makes for category and
 * severity (vision.ts), so this costs no extra request against a five-per-minute
 * free tier. Gemini is not a face detector and will sometimes miss; that is why
 * the complaint email states what was actually done rather than promising a
 * clean image.
 */

/** Pixel blocks across the shorter side of a face box. Lower = coarser. */
const MOSAIC_BLOCKS = 8;

/**
 * Grows each box before pixelating. Detection boxes clip hairlines and chins,
 * and a redaction that leaves half a jaw visible is not a redaction. Mirrors
 * the 18% padding imaging.ts already applies on the device.
 */
const PAD = 0.18;

export interface RedactionOutcome {
  bytes: Uint8Array;
  /** How many boxes were actually pixelated. */
  facesBlurred: number;
  /** False when the image could not be processed at all; bytes are unchanged. */
  ok: boolean;
}

/**
 * Pixelates each box. Returns the input untouched (and ok:false) if anything
 * goes wrong — a failure here must not cost the citizen their report, and the
 * caller records the real count so nothing downstream over-claims.
 */
export async function pixelateFaces(
  input: Uint8Array,
  boxes: FaceBox[]
): Promise<RedactionOutcome> {
  if (!boxes.length) return { bytes: input, facesBlurred: 0, ok: true };

  try {
    const buf = Buffer.from(input);
    const meta = await sharp(buf).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    if (!W || !H) return { bytes: input, facesBlurred: 0, ok: false };

    const overlays: sharp.OverlayOptions[] = [];

    for (const b of boxes) {
      // Gemini returns 0-1000 normalised, ymin/xmin/ymax/xmax.
      let left = (b.xmin / 1000) * W;
      let top = (b.ymin / 1000) * H;
      let width = ((b.xmax - b.xmin) / 1000) * W;
      let height = ((b.ymax - b.ymin) / 1000) * H;

      const padX = width * PAD;
      const padY = height * PAD;
      left -= padX;
      top -= padY;
      width += padX * 2;
      height += padY * 2;

      // Clamp into the frame; sharp throws on an extract outside bounds.
      left = Math.max(0, Math.round(left));
      top = Math.max(0, Math.round(top));
      width = Math.min(W - left, Math.round(width));
      height = Math.min(H - top, Math.round(height));
      if (width < 4 || height < 4) continue;

      // Downsample then blow back up with nearest-neighbour: a mosaic, which is
      // irreversible, rather than a blur, which can be partially undone.
      //
      // TWO PIPELINES, NOT ONE CHAIN. sharp is declarative — a pipeline holds a
      // single resize operation, so `.resize(small).resize(big)` does not mean
      // "shrink then grow", it means the second call REPLACES the first and the
      // tile comes back at its original size, unmodified. That silently turned
      // this whole function into a no-op: it reported the right number of faces
      // blurred, threw nothing, and returned an image that differed only by
      // JPEG re-encode noise.
      const smallW = Math.max(1, Math.round(width / MOSAIC_BLOCKS));
      const smallH = Math.max(1, Math.round(height / MOSAIC_BLOCKS));

      const shrunk = await sharp(buf)
        .extract({ left, top, width, height })
        .resize(smallW, smallH, { kernel: "nearest", fit: "fill" })
        .png()
        .toBuffer();

      // PNG for the tile: a JPEG overlay would soften the block edges we just
      // created, which is the one thing a mosaic must not lose.
      const tile = await sharp(shrunk)
        .resize(width, height, { kernel: "nearest", fit: "fill" })
        .png()
        .toBuffer();

      overlays.push({ input: tile, left, top });
    }

    if (!overlays.length) return { bytes: input, facesBlurred: 0, ok: true };

    const out = await sharp(buf)
      .composite(overlays)
      .jpeg({ quality: 86 })
      .toBuffer();

    return { bytes: new Uint8Array(out), facesBlurred: overlays.length, ok: true };
  } catch (err) {
    console.error("[redact-server] pixelation failed", err);
    return { bytes: input, facesBlurred: 0, ok: false };
  }
}
