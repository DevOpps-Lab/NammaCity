"""
HTTP wrapper over detect.py.

Binds to loopback and has no auth of its own — `/api/dashcam/detect` in the
Next app is the authenticated front door, and nothing outside the box can reach
port 8001 (ufw allows 22/80/443 only). That is also why there is no CORS
middleware here, unlike the project this was adapted from.
"""

import time

import cv2
import numpy as np
from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse

from detect import CONF_THRESHOLD, IMG_SIZE, models, run

app = FastAPI(title="CivicAgent pothole detector", version="1.0.0")


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "models": list(models),
        "imgsz": IMG_SIZE,
        "conf": CONF_THRESHOLD,
    }


@app.post("/infer")
async def infer(frame: UploadFile = File(...)):
    raw = await frame.read()
    if not raw:
        return JSONResponse({"error": "empty frame"}, status_code=400)

    img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return JSONResponse({"error": "not a decodable image"}, status_code=415)

    t0 = time.perf_counter()
    detections, per_model = run(img)
    return {
        "detections": detections,
        "count": len(detections),
        "ms": round((time.perf_counter() - t0) * 1000),
        "width": img.shape[1],
        "height": img.shape[0],
        "perModel": per_model,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8001, log_level="info")
