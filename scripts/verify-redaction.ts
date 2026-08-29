/**
 * End-to-end check of face + number-plate redaction WITHOUT Supabase or the dev
 * server. Calls the real Gemini path (`analyseImage` in src/lib/vision.ts — the
 * same one call the app makes), then covers every face and plate with an opaque
 * box, exactly like the app's on-device pass. Writes a *.redacted.jpg to eyeball.
 *
 *   npx tsx scripts/verify-redaction.ts path/to/photo.jpg
 *
 * Needs GEMINI_API_KEY (read from .env.local automatically).
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { analyseImage } from "../src/lib/vision";

// --- load .env.local (tsx does not do this on its own) ----------------------
for (const line of fs.existsSync(".env.local")
  ? fs.readFileSync(".env.local", "utf8").split("\n")
  : []) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const MAX_EDGE = 1280;

async function main() {
  const src = process.argv[2];
  if (!src || !fs.existsSync(src)) {
    console.error("Usage: npx tsx scripts/verify-redaction.ts <image path>");
    console.error("Give it a photo that contains a face and/or a vehicle number plate.");
    process.exit(1);
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY not set (checked .env.local and the environment).");
    process.exit(1);
  }

  // Mirror rasterizeForDetection(): downscale to 1280 long edge, re-encode JPEG.
  const meta = await sharp(src).rotate().metadata();
  const scale = Math.min(1, MAX_EDGE / Math.max(meta.width ?? 1, meta.height ?? 1));
  const w = Math.round((meta.width ?? 0) * scale);
  const h = Math.round((meta.height ?? 0) * scale);
  const frame = await sharp(src).rotate().resize(w, h).jpeg({ quality: 82 }).toBuffer();

  console.log(`\nFrame: ${w}x${h}, ${(frame.length / 1024).toFixed(0)} KB — calling Gemini…\n`);

  const result = await analyseImage(`data:image/jpeg;base64,${frame.toString("base64")}`);

  if (!result.ok) {
    console.error("Detection failed:", result.kind, "error" in result ? result.error : "");
    console.error("\nIn the app this blocks filing until the user confirms manually.");
    process.exit(1);
  }

  console.log(`category: ${result.category} (${(result.confidence * 100) | 0}% confident)`);
  console.log(`faces:  ${result.faces.length}`);
  console.log(`plates: ${result.plates.length}`);
  const px = (n: number, span: number) => ((n / 1000) * span) | 0;
  for (const [kind, list] of [
    ["face", result.faces],
    ["plate", result.plates],
  ] as const) {
    list.forEach((b, i) =>
      console.log(
        `  ${kind} ${i + 1}: x=${px(b.xmin, w)} y=${px(b.ymin, h)} ` +
          `w=${px(b.xmax - b.xmin, w)} h=${px(b.ymax - b.ymin, h)}`
      )
    );
  }

  // Solid opaque box over every face and plate, with the same 18% padding the
  // app applies in redactRegion().
  const rect = (b: (typeof result.faces)[number]) => {
    const x = px(b.xmin, w);
    const y = px(b.ymin, h);
    const bw = px(b.xmax - b.xmin, w);
    const bh = px(b.ymax - b.ymin, h);
    const pad = Math.round(Math.max(bw, bh) * 0.18);
    return `<rect x="${x - pad}" y="${y - pad}" width="${bw + pad * 2}" height="${
      bh + pad * 2
    }" fill="#111"/>`;
  };
  const boxes = [...result.faces, ...result.plates];
  const overlay = Buffer.from(
    `<svg width="${w}" height="${h}">${boxes.map(rect).join("")}</svg>`
  );

  const out = path.join(
    path.dirname(src),
    path.basename(src, path.extname(src)) + ".redacted.jpg"
  );
  await sharp(frame)
    .composite(boxes.length ? [{ input: overlay, top: 0, left: 0 }] : [])
    .jpeg()
    .toFile(out);

  console.log(`\nWrote ${out} — open it and confirm every face and plate is covered.`);
  if (result.faces.length + result.plates.length === 0) {
    console.log("(Nothing detected — in the app this photo would file with no redaction.)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
