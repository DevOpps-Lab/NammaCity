/**
 * Verifies the dashcam road-ROI geometry.
 *
 *   npm run verify:roi
 *
 * Pure maths, no model and no browser, so it runs in a second and can be
 * trusted as a regression gate. The cases are taken from the measurement that
 * motivated the feature rather than invented: the tree-line box that started
 * all of this is asserted by its real measured position and size.
 *
 * What this deliberately does NOT cover is whether the models find fewer false
 * potholes — that needs weights and video, and lives in the manual check in
 * deploy/README.md. This covers the part that can silently rot: the geometry.
 */

import {
  DEFAULT_ROI,
  ROI_HORIZON_MAX,
  ROI_HORIZON_MIN,
  ROI_TOP_MAX,
  ROI_TOP_MIN,
  filterToRoi,
  insideRoi,
  roiBounds,
  roiCorners,
  type Roi,
} from "../src/lib/roi";

const W = 1920;
const H = 1080;

let failures = 0;
const ok = (label: string, detail = "") =>
  console.log(`  \x1b[32mPASS\x1b[0m  ${label}${detail ? `  ${detail}` : ""}`);
const bad = (label: string, detail = "") => {
  failures++;
  console.log(`  \x1b[31mFAIL\x1b[0m  ${label}${detail ? `  ${detail}` : ""}`);
};
const check = (cond: boolean, label: string, detail = "") =>
  cond ? ok(label, detail) : bad(label, detail);

/** Centre-based helper — the ROI test is on box centres, so build them that way. */
const boxAt = (fx: number, fy: number, fw = 0.05, fh = 0.05) => ({
  x: fx * W - (fw * W) / 2,
  y: fy * H - (fh * H) / 2,
  width: fw * W,
  height: fh * H,
});

console.log("\nROI geometry\n");

// ── the case that motivated the feature ────────────────────────────────────
// Measured on the snowy-highway clip: 8 of 14 detections were over 15% of the
// frame, the largest 35.1% at confidence 0.50, centred on the left tree line.
const treeBox = boxAt(0.27, 0.27, 0.59, 0.59);
check(
  !insideRoi(DEFAULT_ROI, W, H, treeBox),
  "the 35%-of-frame tree-line box is rejected",
  "centre (0.27W, 0.27H)"
);

// The road surface directly ahead is the whole point; if this ever fails the
// feature is worse than useless, because it would reject the subject.
check(insideRoi(DEFAULT_ROI, W, H, boxAt(0.5, 0.9)), "road directly ahead is kept");
check(insideRoi(DEFAULT_ROI, W, H, boxAt(0.5, 0.45)), "road near the horizon is kept");

// ── the trapezoid actually narrows ─────────────────────────────────────────
// A rectangle would pass the two tests above. This is what proves it is a wedge:
// the same horizontal offset is inside low in the frame and outside high up.
const offset = 0.36;
check(
  insideRoi(DEFAULT_ROI, W, H, boxAt(0.5 + offset, 0.98)) &&
    !insideRoi(DEFAULT_ROI, W, H, boxAt(0.5 + offset, 0.45)),
  "the shape narrows toward the horizon",
  "same x, inside at the bottom, outside at the top"
);

// Symmetry — a lopsided wedge would quietly favour one side of the road.
const mirror = [0.05, 0.2, 0.35].every(
  (d) =>
    insideRoi(DEFAULT_ROI, W, H, boxAt(0.5 - d, 0.8)) ===
    insideRoi(DEFAULT_ROI, W, H, boxAt(0.5 + d, 0.8))
);
check(mirror, "left and right are symmetric");

// ── above the horizon is always out ────────────────────────────────────────
check(
  !insideRoi(DEFAULT_ROI, W, H, boxAt(0.5, DEFAULT_ROI.horizon - 0.05)),
  "sky above the horizon is rejected",
  "even dead centre"
);

// ── bounds are safe to hand to a cropper ───────────────────────────────────
// drawImage yields a blank region outside the source and sharp throws outright,
// so an out-of-range rect is a real failure, not a cosmetic one.
const extremes: Roi[] = [
  DEFAULT_ROI,
  { horizon: ROI_HORIZON_MIN, topHalf: ROI_TOP_MAX, bottomHalf: 0.5 },
  { horizon: ROI_HORIZON_MAX, topHalf: ROI_TOP_MIN, bottomHalf: 0.5 },
  { horizon: 0.999, topHalf: 0.5, bottomHalf: 0.5 },
  { horizon: 0, topHalf: 0.5, bottomHalf: 0.5 },
];
const sizes: [number, number][] = [
  [1920, 1080],
  [640, 360],
  [1080, 1080],
  [321, 241],
];
const boundsSafe = extremes.every((r) =>
  sizes.every(([w, h]) => {
    const b = roiBounds(r, w, h);
    return (
      b.sx >= 0 && b.sy >= 0 && b.sw >= 1 && b.sh >= 1 && b.sx + b.sw <= w && b.sy + b.sh <= h
    );
  })
);
check(boundsSafe, "roiBounds stays inside the frame", `${extremes.length} shapes x ${sizes.length} sizes`);

// Every kept box must lie within the crop that was actually analysed, or the
// ROI is filtering against a region the model never saw.
const insideBounds = sizes.every(([w, h]) => {
  const b = roiBounds(DEFAULT_ROI, w, h);
  const pts: [number, number][] = [];
  for (let fx = 0; fx <= 1.0001; fx += 0.05)
    for (let fy = 0; fy <= 1.0001; fy += 0.05) pts.push([fx, fy]);
  return pts.every(([fx, fy]) => {
    const box = { x: fx * w, y: fy * h, width: 1, height: 1 };
    if (!insideRoi(DEFAULT_ROI, w, h, box)) return true;
    const cx = box.x + 0.5;
    const cy = box.y + 0.5;
    return cx >= b.sx && cx <= b.sx + b.sw && cy >= b.sy && cy <= b.sy + b.sh;
  });
});
check(insideBounds, "kept boxes always fall within the analysed crop");

// ── the sliders do something ───────────────────────────────────────────────
const probe = boxAt(0.5, 0.35);
check(
  !insideRoi({ ...DEFAULT_ROI, horizon: 0.45 }, W, H, probe) &&
    insideRoi({ ...DEFAULT_ROI, horizon: 0.3 }, W, H, probe),
  "the horizon slider changes membership"
);
const wide = boxAt(0.8, 0.6);
check(
  insideRoi({ ...DEFAULT_ROI, topHalf: ROI_TOP_MAX }, W, H, wide) !==
    insideRoi({ ...DEFAULT_ROI, topHalf: ROI_TOP_MIN }, W, H, wide),
  "the width slider changes membership"
);

// ── the opt-out is genuinely a no-op ───────────────────────────────────────
// This is the promise made to close-up footage: unticking the box must restore
// the previous behaviour exactly, not merely a generous version of it.
const all = [treeBox, boxAt(0.5, 0.9), boxAt(0.05, 0.05), boxAt(0.95, 0.02)];
check(filterToRoi(null, W, H, all).length === all.length, "roi: null keeps every box");
check(filterToRoi(undefined, W, H, all).length === all.length, "roi: undefined keeps every box");
check(
  filterToRoi(DEFAULT_ROI, W, H, all).length < all.length,
  "roi: set removes something",
  `${all.length} -> ${filterToRoi(DEFAULT_ROI, W, H, all).length}`
);

// ── corners are the shape the overlay draws ────────────────────────────────
// The outline is the user's only evidence of what is being ignored; if it
// disagrees with the filter, the UI is lying about the detector.
const c = roiCorners(DEFAULT_ROI, W, H);
check(
  c.length === 4 &&
    c[0][1] === c[1][1] &&
    c[2][1] === H &&
    c[3][1] === H &&
    c[1][0] - c[0][0] < c[2][0] - c[3][0],
  "corners form a bottom-anchored wedge",
  "top edge narrower than the bottom"
);

console.log(
  failures === 0
    ? "\n\x1b[32mAll ROI checks passed.\x1b[0m\n"
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`
);
process.exit(failures === 0 ? 0 : 1);
