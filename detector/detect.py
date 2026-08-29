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

  - Its trapezoidal ROI mask. Blacking out everything off-road scored WORSE than
    the full frame in every case measured (0/2/1 against 9/7/3) — YOLO is handed
    an image unlike anything in its training set. The browser detector already
    learned this the hard way and unions a zoomed crop with the full frame
    rather than replacing it.
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


def run(frame: np.ndarray) -> tuple[list[dict], dict]:
    """Full frame through every model, unioned. No ROI masking — see the header."""
    found: list[dict] = []
    per_model: dict = {}

    for name, model in models.items():
        t0 = time.perf_counter()
        result = model(frame, conf=CONF_THRESHOLD, imgsz=IMG_SIZE, verbose=False)[0]
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
