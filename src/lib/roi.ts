/**
 * The road-ahead region of interest: a trapezoid the dashcam detector looks
 * inside, and nowhere else.
 *
 * WHY THIS EXISTS. A dry run flagged trees and shadows as potholes. Measured on
 * the snowy-highway clip with both server models at conf 0.35, 8 of 14
 * detections covered MORE THAN 15% of the frame — the largest 35.1% at conf
 * 0.50 — all clustered on the left tree line at (0.27W, 0.27H). Restricting
 * inference to the road wedge took the giant boxes from 8 to 0.
 *
 * A NOTE ON THE EVIDENCE THAT CAME BEFORE. Two earlier comments in this
 * codebase argued against exactly this, on the strength of detection COUNTS
 * falling when an ROI was applied. That reasoning does not hold: without ground
 * truth a lost false positive and a lost pothole look identical in a count, and
 * a drop is precisely what a working precision filter produces. What was
 * actually measured and rejected was the upstream project's MASK — blacking
 * off-road pixels to a flat colour, which hands YOLO an image unlike anything
 * in its training set. Cropping is not masking: the pixels stay real, and the
 * road gets more of the 640px input, which is the same reason ZOOM_RECT exists.
 *
 * The geometry is stored as fractions rather than pixels so one setting holds
 * across 1920x1080 dashcam footage and 640x360 phone clips alike.
 */

/**
 * A trapezoid, symmetric about the frame's vertical centre line.
 *
 * The bottom edge is the bottom of the frame, which is where the road is in any
 * forward-facing mount — an ROI that floats above the bottom edge would ignore
 * the tarmac directly ahead, which is the part in sharpest focus.
 */
export interface Roi {
  /** Height of the trapezoid's top edge, as a fraction of frame height. */
  horizon: number;
  /** Half-width of the top edge, as a fraction of frame width. */
  topHalf: number;
  /** Half-width of the bottom edge, as a fraction of frame width. */
  bottomHalf: number;
}

/**
 * The most balanced point in a sweep over three clips: it kept the road-surface
 * detections on both wide clips while removing every oversized tree box.
 * Tighter wedges scored better on precision and started dropping real potholes
 * on the clip with a curving road, which is why this is a default and not a
 * constant — see the sliders in DashcamTab.
 */
export const DEFAULT_ROI: Roi = { horizon: 0.4, topHalf: 0.3, bottomHalf: 0.5 };

/** Slider bounds. Above 0.65 the wedge is a sliver; below 0.25 it is the sky. */
export const ROI_HORIZON_MIN = 0.25;
export const ROI_HORIZON_MAX = 0.65;
/** A top edge narrower than 0.08W cannot contain a box centre at any distance. */
export const ROI_TOP_MIN = 0.08;
export const ROI_TOP_MAX = 0.5;

export interface RoiRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** The four corners in frame pixels, clockwise from the top-left. */
export function roiCorners(
  roi: Roi,
  w: number,
  h: number
): [number, number][] {
  const cx = w / 2;
  const top = roi.horizon * h;
  const tw = roi.topHalf * w;
  const bw = roi.bottomHalf * w;
  return [
    [cx - tw, top],
    [cx + tw, top],
    [cx + bw, h],
    [cx - bw, h],
  ];
}

/**
 * The bounding rect to crop and hand the model.
 *
 * Clamped into the frame because callers pass slider values and a crop outside
 * the source is a runtime error in both paths — `drawImage` yields a blank
 * region and sharp throws outright (see the clamping in redact-server.ts).
 */
export function roiBounds(roi: Roi, w: number, h: number): RoiRect {
  const cx = w / 2;
  const half = Math.max(roi.topHalf, roi.bottomHalf) * w;
  const sx = Math.max(0, Math.round(cx - half));
  const sy = Math.max(0, Math.min(h - 1, Math.round(roi.horizon * h)));
  return {
    sx,
    sy,
    sw: Math.max(1, Math.min(w - sx, Math.round(cx + half) - sx)),
    sh: Math.max(1, h - sy),
  };
}

/**
 * Whether a box's centre falls inside the trapezoid.
 *
 * The crop handed to the model is a RECTANGLE; the ROI is not. Without this the
 * rectangle's top corners are still analysed, and on the highway clip those
 * corners are exactly where the tree line sits — so this is the step that
 * actually removes the false positives, not the crop.
 *
 * No general point-in-polygon needed. The shape is symmetric with straight
 * edges, so the permitted half-width at any row is a linear interpolation
 * between the two edges.
 */
export function insideRoi(
  roi: Roi,
  w: number,
  h: number,
  box: { x: number; y: number; width: number; height: number }
): boolean {
  const cy = box.y + box.height / 2;
  const top = roi.horizon * h;
  if (cy < top || cy > h) return false;

  // Guard the degenerate case where the horizon sits on the bottom edge.
  const span = h - top;
  const t = span <= 0 ? 1 : (cy - top) / span;
  const half = (roi.topHalf + (roi.bottomHalf - roi.topHalf) * t) * w;

  return Math.abs(box.x + box.width / 2 - w / 2) <= half;
}

/** `insideRoi` over a list. A null roi is a no-op, not an empty result. */
export function filterToRoi<
  T extends { x: number; y: number; width: number; height: number },
>(roi: Roi | null | undefined, w: number, h: number, boxes: T[]): T[] {
  if (!roi) return boxes;
  return boxes.filter((b) => insideRoi(roi, w, h, b));
}
