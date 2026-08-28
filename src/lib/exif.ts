/**
 * JPEG METADATA STRIPPER — server-side, zero dependencies.
 *
 * The app's privacy guarantee is that a photo is redacted BEFORE it is
 * uploaded: `src/lib/imaging.ts` pixelates faces and drops EXIF as a side
 * effect of a canvas round-trip. That module is `"use client"` and needs canvas
 * plus TF.js, so it cannot run on a webhook. A photo arriving from a Twilio
 * media URL has had none of it.
 *
 * Face pixelation genuinely cannot be reproduced here without adding a
 * detection stack to the server. Removing metadata can, and it is the half
 * that leaks hardest: EXIF can carry the exact GPS coordinates of whoever took
 * the photo, their device, and a timestamp. So this strips it, and the report
 * records `source = 'whatsapp'` so the weaker guarantee stays visible instead
 * of being quietly implied away.
 *
 * Written by hand rather than with `sharp` on purpose: `sharp` is not a
 * dependency of this project, and a native module is a poor thing to add for
 * one function. This is a byte walk over the JPEG segment table, which is a
 * stable, well-specified format.
 */

/** Segments carrying no length field, so the walker must not try to skip one. */
const STANDALONE = new Set([
  0xd8, // SOI
  0xd9, // EOI
  0x01, // TEM
  0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, // RSTn
]);

/**
 * Markers dropped wholesale.
 *   APP1  Exif and XMP — GPS, device, timestamps. The reason this exists.
 *   APP2+ ICC, Photoshop IRB, and assorted vendor blobs.
 *   COM   free-text comments.
 * APP0 (JFIF, 0xe0) is deliberately KEPT: it is structural and some decoders
 * are unhappy without it.
 */
function isStrippable(marker: number): boolean {
  if (marker >= 0xe1 && marker <= 0xef) return true; // APP1..APP15
  return marker === 0xfe; // COM
}

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/**
 * Returns a copy of `input` with EXIF/XMP/comment segments removed.
 *
 * Non-JPEG input is returned untouched — the caller decides what to accept, and
 * silently corrupting a PNG would be worse than not stripping it. Malformed
 * JPEGs are likewise returned as-is rather than half-rewritten.
 */
export function stripJpegMetadata(input: Uint8Array): Uint8Array {
  if (!isJpeg(input)) return input;

  const keep: Array<[number, number]> = []; // [start, end) ranges to copy
  let i = 2; // past SOI
  let cursor = 0; // start of the current run we intend to keep
  keep.push([0, 2]);
  cursor = 2;

  while (i < input.length) {
    if (input[i] !== 0xff) {
      // Not at a marker boundary — the file is not shaped as expected. Bail out
      // and keep everything, rather than emit a subtly broken image.
      return input;
    }

    // Marker padding: any number of 0xFF bytes may precede the marker code.
    let j = i;
    while (j < input.length && input[j] === 0xff) j++;
    if (j >= input.length) return input;
    const marker = input[j];

    if (marker === 0xda) {
      // Start of Scan: entropy-coded data follows, with no segment table.
      // Everything from here to the end is copied verbatim.
      keep.push([cursor, input.length]);
      break;
    }

    if (STANDALONE.has(marker)) {
      i = j + 1;
      continue;
    }

    if (j + 2 >= input.length) return input;
    const length = (input[j + 1] << 8) | input[j + 2];
    if (length < 2) return input;
    const segmentStart = i;
    const segmentEnd = j + 1 + length; // marker code + length-counted payload
    if (segmentEnd > input.length) return input;

    if (isStrippable(marker)) {
      // Close the run before this segment and resume after it.
      if (segmentStart > cursor) keep.push([cursor, segmentStart]);
      cursor = segmentEnd;
    }

    i = segmentEnd;
  }

  if (i >= input.length && cursor < input.length) keep.push([cursor, input.length]);

  const total = keep.reduce((n, [s, e]) => n + (e - s), 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const [s, e] of keep) {
    out.set(input.subarray(s, e), at);
    at += e - s;
  }
  return out;
}

/** True when an Exif (APP1) segment is present. Used by the verification script. */
export function hasExifSegment(bytes: Uint8Array): boolean {
  if (!isJpeg(bytes)) return false;
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) return false;
    let j = i;
    while (j < bytes.length && bytes[j] === 0xff) j++;
    const marker = bytes[j];
    if (marker === 0xda) return false;
    if (STANDALONE.has(marker)) {
      i = j + 1;
      continue;
    }
    if (j + 2 >= bytes.length) return false;
    const length = (bytes[j + 1] << 8) | bytes[j + 2];
    if (marker === 0xe1) return true;
    if (length < 2) return false;
    i = j + 1 + length;
  }
  return false;
}
