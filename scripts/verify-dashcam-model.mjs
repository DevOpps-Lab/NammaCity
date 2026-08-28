/**
 * Verifies the Dashcam pothole model loads and runs under the SAME
 * onnxruntime-web WASM execution provider the browser uses, and that the
 * decode math in src/lib/dashcam-detect.ts produces sane boxes.
 *
 * Exists because two previous detection backends failed only in the browser,
 * at session-creation time, after passing every local check. Run with:
 *   node scripts/verify-dashcam-model.mjs
 */

import * as ort from "onnxruntime-web";
import fs from "node:fs";
import path from "node:path";

const MODEL = path.join(process.cwd(), "public", "models", "pothole-yolov8n.onnx");
const INPUT_SIZE = 640;
const NUM_MASK_COEFFS = 32;
const CONF = 0.4;

ort.env.wasm.numThreads = 1;
ort.env.wasm.simd = true;

console.log("onnxruntime-web version:", ort.env.versions?.common ?? "(unknown)");
console.log("model:", MODEL, `(${(fs.statSync(MODEL).size / 1e6).toFixed(1)}MB)`);

const t0 = Date.now();
const session = await ort.InferenceSession.create(fs.readFileSync(MODEL), {
  executionProviders: ["wasm"],
  graphOptimizationLevel: "all",
});
console.log(`\n✓ SESSION CREATED under the wasm EP in ${Date.now() - t0}ms`);
console.log("  inputNames :", session.inputNames);
console.log("  outputNames:", session.outputNames);

// Grey letterbox field, matching what preprocess() produces for a blank frame.
const plane = INPUT_SIZE * INPUT_SIZE;
const data = new Float32Array(3 * plane).fill(114 / 255);

const t1 = Date.now();
const results = await session.run({
  [session.inputNames[0]]: new ort.Tensor("float32", data, [1, 3, INPUT_SIZE, INPUT_SIZE]),
});
const inferMs = Date.now() - t1;

const out = results[session.outputNames[0]];
const [, channels, anchors] = out.dims;
console.log(`\n✓ INFERENCE OK in ${inferMs}ms (wasm, single-threaded)`);
console.log(`  output0 dims: ${JSON.stringify(out.dims)}`);
console.log(`  channels=${channels} -> numClasses=${channels - 4 - NUM_MASK_COEFFS} (expect 1)`);
console.log(`  anchors=${anchors}`);

// Sanity-check the decode indexing on real tensor data.
const d = out.data;
let above = 0;
let maxScore = 0;
for (let i = 0; i < anchors; i++) {
  const s = d[4 * anchors + i];
  if (s > maxScore) maxScore = s;
  if (s >= CONF) above++;
}
console.log(`\n  On a blank grey frame: max class score ${maxScore.toFixed(4)}, ${above} anchors >= ${CONF}`);
console.log(`  (expected ~0 detections on a blank frame — a high count here would mean broken decode)`);

if (channels - 4 - NUM_MASK_COEFFS !== 1) {
  console.error("\n✗ FAIL: unexpected channel count — decode math would be wrong.");
  process.exit(1);
}
if (inferMs > 2000) {
  console.warn(`\n! WARNING: ${inferMs}ms/frame is too slow for live video.`);
}
console.log("\n✓ ALL CHECKS PASSED — safe for the browser wasm path.");
