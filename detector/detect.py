"""
Pothole detection — models, inference and the cross-model union.

Deliberately free of any web framework so it can be imported and tested on its
own: `python -c "import detect; detect.run(frame)"` needs only ultralytics,
opencv and numpy. server.py is a thin HTTP wrapper over this.

WHY THIS EXISTS AT ALL. Benchmarked on three dashcam clips, the app's in-browser
`pothole_yolov8n` and the larger `best.pt` turned out to be COMPLEMENTARY rather
than one being better: full-frame detections were 9/0/3 and 0/7/11 respectively.
Ours wins decisively on phone-shot footage, theirs on the other two. The value is
in running both and unioning, and a server can hold 28 MB of weights where a
browser would have to download them.

WHAT WAS DELIBERATELY NOT COPIED from the upstream project this came from:

  - Its trapezoidal ROI MASK. Blacking out off-road pixels to a flat colour
    hands YOLO an image unlike anything in its training set.

    An earlier version of this comment went further and rejected the whole idea
    of a region of interest, citing detection counts falling from 9/7/3 to
    0/2/1. That inference was wrong and is corrected here: without ground truth
    a count cannot tell a discarded false positive from a discarded pothole, and
    a drop is exactly what a working precision filter produces. Re-measured, the
    highway clip's full-frame output included 8 boxes covering more than 15% of
    the frame — one of them 35.1%, at confidence 0.50 — all on the tree line.

    A CROPPED region of interest does now ship, in the browser
    (src/lib/roi.ts), where the user can see and aim it. It stays out of this
    file on purpose: the client crops before uploading, so the wedge has one
    implementation instead of two that could drift apart.
  - Its incident queue, screenshot writer and JSONL log. The app has a reporting
    pipeline already; a second one would be a competing source of truth.

"""

import os
import time
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from ultralytics import YOLO

MODELS_DIR = Path(__file__).parent / "models"
CONF_THRESHOLD = float(os.getenv("DETECTOR_CONF", "0.35"))
NMS_IOU = 0.45
# The browser detector letterboxes to 640; matching it keeps the two paths
# comparable when one falls back to the other.
IMG_SIZE = int(os.getenv("DETECTOR_IMGSZ", "640"))

# `best.pt` was trained without class names and reports its single class as the
# string "0". Mapped here so the API never emits a box labelled 0.
CLASS_ALIASES = {"0": "pothole", "Pothole": "pothole"}

# Order matters only for tie-breaking; both run on every frame.
MODEL_FILES = ["pothole_yolov8n.pt", "best.pt"]

models: dict[str, Any] = {}
for name in MODEL_FILES:
    path = MODELS_DIR / name
    if not path.exists():
        print(f"[detector] {name} not found at {path} — skipping")
        continue
    print(f"[detector] loading {name} …")
    models[name] = YOLO(str(path))

if not models:
    raise SystemExit(
        f"No models found in {MODELS_DIR}. Run deploy/setup-detector.sh first."
    )
print(f"[detector] ready with {len(models)} model(s): {', '.join(models)}")


def _warmup() -> None:
    """
    Push one synthetic frame through every model at import.

    Torch initialises lazily, so without this the FIRST real frame pays it:
    measured 2150 ms against ~150 ms for every frame after. That cost is
    unavoidable, but it belongs in `systemctl start` where nobody is watching,
    not in the first second of somebody's dashcam scan.
    """
    blank = np.zeros((IMG_SIZE, IMG_SIZE, 3), dtype=np.uint8)
    t0 = time.perf_counter()
    for model in models.values():
        model(blank, conf=CONF_THRESHOLD, imgsz=IMG_SIZE, verbose=False)
    print(f"[detector] warmed up in {(time.perf_counter() - t0) * 1000:.0f} ms")


def iou(a: dict, b: dict) -> float:
    ax2, ay2 = a["x"] + a["width"], a["y"] + a["height"]
    bx2, by2 = b["x"] + b["width"], b["y"] + b["height"]
    ix = max(0.0, min(ax2, bx2) - max(a["x"], b["x"]))
    iy = max(0.0, min(ay2, by2) - max(a["y"], b["y"]))
    inter = ix * iy
    if inter <= 0:
        return 0.0
    union = a["width"] * a["height"] + b["width"] * b["height"] - inter
    return inter / union if union > 0 else 0.0


def nms(boxes: list[dict]) -> list[dict]:
    """
    Suppression ACROSS models only — never within one.

    Two models finding the same pothole must collapse to one box. But a box is
    only ever compared against boxes from a *different* model, and that
    restriction is load-bearing rather than an optimisation.

    Ultralytics has already run NMS inside each model, at its own default IoU of
    0.7. Re-suppressing that output at our stricter 0.45 does not remove
    duplicates — it overrules the model about two nearby potholes being two
    potholes. Measured: on one clip `best.pt` returned 7 boxes and a naive
    single-pass union returned 6, having silently deleted a real detection.

    So: each model's own output is taken as final, and this only removes the
    cross-model agreement that would otherwise be double-counted.
    """
    kept: list[dict] = []
    for box in sorted(boxes, key=lambda b: -b["confidence"]):
        clash = any(
            k.get("model") != box.get("model") and iou(k, box) >= NMS_IOU for k in kept
        )
        if not clash:
            kept.append(box)
    return kept


def run(frame: np.ndarray, conf: float | None = None) -> tuple[list[dict], dict]:
    """
    Every model over whatever image it is handed, unioned.

    `conf` is per-request because the caller owns the precision/recall trade:
    the UI has a sensitivity slider, and without this the server ran at its own
    fixed default and the slider silently did nothing whenever the server path
    was selected. Falls back to CONF_THRESHOLD when absent.

    The frame may already be an ROI crop — the client does that, and the boxes
    come back in the crop's coordinate space for it to offset. See the header.
    """
    found: list[dict] = []
    per_model: dict = {}
    floor = CONF_THRESHOLD if conf is None else min(max(conf, 0.01), 0.95)

    for name, model in models.items():
        t0 = time.perf_counter()
        result = model(frame, conf=floor, imgsz=IMG_SIZE, verbose=False)[0]
        count = 0
        if result.boxes is not None:
            for box in result.boxes:
                x1, y1, x2, y2 = (float(v) for v in box.xyxy[0].tolist())
                raw_label = model.names.get(int(box.cls[0]), "pothole")
                found.append(
                    {
                        "x": x1,
                        "y": y1,
                        "width": x2 - x1,
                        "height": y2 - y1,
                        "confidence": round(float(box.conf[0]), 4),
                        "classLabel": CLASS_ALIASES.get(str(raw_label), str(raw_label)),
                        "model": name,
                    }
                )
                count += 1
        per_model[name] = {"raw": count, "ms": round((time.perf_counter() - t0) * 1000)}

    return nms(found), per_model


_warmup()
