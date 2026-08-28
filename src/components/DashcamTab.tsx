"use client";

/**
 * DASHCAM MODE
 *
 * Upload a video simulating a drive. It plays hidden behind a canvas that
 * mirrors every frame; a purpose-trained YOLOv8n pothole model (via
 * onnxruntime-web, on-device) runs against that canvas in a
 * requestAnimationFrame loop, and detections are drawn back onto it as boxes
 * + confidence scores. A pothole seen above 40% confidence is captured into a
 * local Draft Queue, throttled to at most one capture every 3 seconds so one
 * pothole visible for several seconds of footage doesn't flood the queue
 * with near-duplicates.
 *
 * First use costs a ~40MB one-time download (our 13MB model from /public, plus
 * onnxruntime's ~27MB WASM/WebGPU runtime), browser-cached afterwards. It
 * starts as soon as this tab mounts and reports real progress, because a
 * 40MB silent wait is indistinguishable from a hang.
 *
 * Filing is NOT reimplemented here. Clicking a queue frame hands it to the
 * exact same ReportTab a manual citizen report goes through (category
 * confirmation, redaction, authority resolution, the works) — this component
 * never calls fileReport itself, so there is exactly one place a report gets
 * filed from.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Icon from "./Icon";
import {
  loadDetector,
  detectPotholes,
  ROAD_ROI_TOP_FRACTION,
  type DashcamDetection,
  type DetectorProgress,
} from "@/lib/dashcam-detect";

interface DraftFrame {
  id: string;
  capturedAtMs: number;
  snapshotDataUrl: string;
  confidence: number;
  classLabel: string;
}

/** How often detectPotholes() runs — independent of the rAF draw rate. */
const INFER_INTERVAL_MS = 250;
/** Below this, a detection is too unreliable to bother the queue with. */
const MIN_CONFIDENCE = 0.4;
/** Minimum gap between two captures, regardless of how many boxes are on screen. */
const CAPTURE_THROTTLE_MS = 3000;

export default function DashcamTab({
  onOpenReport,
}: {
  /** Hands a captured frame to the standard report flow. Never files directly. */
  onOpenReport: (file: File) => void;
}) {
  const [detectorState, setDetectorState] = useState<"loading" | "ready" | "error">("loading");
  const [detectorProgress, setDetectorProgress] = useState<number | null>(null);
  // Two distinct waits worth naming: our 13MB model download (which we can
  // measure) and onnxruntime's own ~27MB WASM/WebGPU runtime plus warmup
  // (which it fetches internally, so we can only say it's happening).
  const [detectorPhase, setDetectorPhase] = useState<"download" | "initializing">("download");
  const [driving, setDriving] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [frames, setFrames] = useState<DraftFrame[]>([]);

  // Doesn't reset state itself — called once on mount (defaults are already
  // "loading"/null) and from the Retry button (which resets state itself,
  // synchronously, in its own click handler rather than here).
  const beginDetectorLoad = useCallback(() => {
    loadDetector((info: DetectorProgress) => {
      if (info.status === "initializing") setDetectorPhase("initializing");
      // Some progress events omit `progress` entirely — stay on the
      // indeterminate spinner rather than showing NaN%.
      if (typeof info.progress === "number") setDetectorProgress(info.progress);
    })
      .then(() => setDetectorState("ready"))
      .catch((err) => {
        console.warn("[DashcamTab] pothole detector failed to load:", err);
        setDetectorState("error");
      });
  }, []);

  const retryDetectorLoad = useCallback(() => {
    setDetectorState("loading");
    setDetectorProgress(null);
    setDetectorPhase("download");
    beginDetectorLoad();
  }, [beginDetectorLoad]);

  useEffect(() => {
    beginDetectorLoad();
  }, [beginDetectorLoad]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /**
   * Offscreen canvas holding ONLY the raw video frame.
   *
   * This exists because of a real bug: inference used to run on the visible
   * canvas, which by then already had this frame's green boxes and labels
   * painted on it. The model was being shown its own annotations and detecting
   * them, a feedback loop that produced confident boxes on nothing. The same
   * frame was also what got captured, so a filed report's photo had debug
   * rectangles burned in. Inference and capture both read this clean copy;
   * only the visible canvas ever gets drawn on.
   */
  const frameRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const busyRef = useRef(false);
  const lastInferAtRef = useRef(0);
  const lastCaptureAtRef = useRef(0);
  const lastBoxesRef = useRef<DashcamDetection[]>([]);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const captureFrame = useCallback((canvas: HTMLCanvasElement, d: DashcamDetection, atMs: number) => {
    const frame: DraftFrame = {
      id: crypto.randomUUID(),
      capturedAtMs: atMs,
      snapshotDataUrl: canvas.toDataURL("image/jpeg", 0.85),
      confidence: d.confidence,
      classLabel: d.classLabel,
    };
    setFrames((prev) => [frame, ...prev]);
  }, []);

  /**
   * Marks the top of the scanned road region. Without it, a citizen seeing an
   * obvious pothole ignored high in the frame has no way to know the detector
   * deliberately never looks there.
   */
  const drawRoiGuide = useCallback((ctx: CanvasRenderingContext2D) => {
    const { width, height } = ctx.canvas;
    const y = Math.floor(height * ROAD_ROI_TOP_FRACTION);
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.45)";
    ctx.lineWidth = Math.max(1, width / 640);
    ctx.setLineDash([Math.max(4, width / 90), Math.max(4, width / 90)]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = `${Math.max(10, Math.round(width / 64))}px sans-serif`;
    ctx.fillText("scanning below this line", Math.round(width / 100), y - Math.round(width / 150));
    ctx.restore();
  }, []);

  const drawBoxes = useCallback((ctx: CanvasRenderingContext2D, boxes: DashcamDetection[]) => {
    if (!boxes.length) return;
    const { width } = ctx.canvas;
    const lineWidth = Math.max(2, width / 240);
    ctx.strokeStyle = "#059669";
    ctx.lineWidth = lineWidth;
    ctx.font = `${Math.max(12, Math.round(width / 45))}px sans-serif`;

    for (const b of boxes) {
      ctx.strokeRect(b.x, b.y, b.width, b.height);
      const label = `pothole ${Math.round(b.confidence * 100)}%`;
      const textW = ctx.measureText(label).width;
      const labelH = Math.max(16, Math.round(width / 32));
      ctx.fillStyle = "#059669";
      ctx.fillRect(b.x, Math.max(0, b.y - labelH), textW + 8, labelH);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, b.x + 4, Math.max(labelH - 5, b.y - 5));
    }
  }, []);

  // requestAnimationFrame loops that call themselves by name need an
  // indirection ref — `loop` can't appear inside its own useCallback body
  // before it's declared. The assignment happens in an effect, not during
  // render, since refs may only be written outside of render.
  const loopRef = useRef<() => void>(() => {});
  const loopImpl = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.paused || video.ended) {
      rafRef.current = null;
      return;
    }
    const ctx = canvas.getContext("2d");
    const frame = frameRef.current;
    const fctx = frame?.getContext("2d");
    if (!ctx || !frame || !fctx) return;

    // Clean frame first (model + capture read this), then the visible copy
    // with the overlay drawn on top. Never annotate what the model will see.
    fctx.drawImage(video, 0, 0, frame.width, frame.height);
    ctx.drawImage(frame, 0, 0);
    drawRoiGuide(ctx);
    drawBoxes(ctx, lastBoxesRef.current);

    const now = performance.now();
    if (now - lastInferAtRef.current > INFER_INTERVAL_MS && !busyRef.current) {
      lastInferAtRef.current = now;
      busyRef.current = true;
      const currentTimeMs = video.currentTime * 1000;
      detectPotholes(frame)
        .then((detections) => {
          lastBoxesRef.current = detections;
          const best = detections.reduce<DashcamDetection | null>(
            (top, d) => (d.confidence >= MIN_CONFIDENCE && (!top || d.confidence > top.confidence) ? d : top),
            null
          );
          if (best && now - lastCaptureAtRef.current >= CAPTURE_THROTTLE_MS) {
            lastCaptureAtRef.current = now;
            // Capture from the CLEAN frame — this image is handed to ReportTab
            // and ends up as the filed report's photo, so it must not carry
            // detection overlays.
            captureFrame(frame, best, currentTimeMs);
          }
        })
        .catch(() => {
          /* detectPotholes already logs; keep the loop alive */
        })
        .finally(() => {
          busyRef.current = false;
        });
    }

    rafRef.current = requestAnimationFrame(() => loopRef.current());
  }, [captureFrame, drawBoxes, drawRoiGuide]);

  useEffect(() => {
    loopRef.current = loopImpl;
  }, [loopImpl]);

  const onPickVideo = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    setVideoUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return url;
    });
    setFrames([]);
    lastCaptureAtRef.current = 0;
    lastBoxesRef.current = [];
    setDriving(true);
  }, []);

  const onLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    // Clean offscreen twin, same dimensions. Built fresh rather than resized
    // in place, so nothing read out of the ref is mutated.
    const frame = document.createElement("canvas");
    frame.width = video.videoWidth;
    frame.height = video.videoHeight;
    frameRef.current = frame;
  }, []);

  const onPlay = useCallback(() => {
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(() => loopRef.current());
  }, []);

  const onEnded = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setDriving(false);
  }, []);

  const stopDrive = useCallback(() => {
    videoRef.current?.pause();
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setDriving(false);
  }, []);

  const openFrame = useCallback(
    async (frame: DraftFrame) => {
      const blob = await (await fetch(frame.snapshotDataUrl)).blob();
      const file = new File([blob], `dashcam-${frame.id}.jpg`, { type: blob.type });
      onOpenReport(file);
    },
    [onOpenReport]
  );

  if (detectorState === "error") {
    return (
      <Shell>
        <div className="rise-in rounded-2xl border border-[var(--danger)]/35 bg-[var(--danger)]/10 p-5 text-center">
          <Icon name="alert" size={28} className="mx-auto mb-3 text-[var(--danger)]" />
          <p className="text-[14px] font-semibold">Couldn&apos;t load the pothole detector</p>
          <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--text-dim)]">
            The detector didn&apos;t finish loading — usually a network hiccup on the one-time
            ~40MB download. Every other tab works normally without it.
          </p>
          <button
            onClick={retryDetectorLoad}
            className="mt-3 rounded-lg border border-[var(--border)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-dim)] hover:border-[var(--border-strong)] hover:text-[var(--text)]"
          >
            Retry
          </button>
        </div>
      </Shell>
    );
  }

  if (detectorState === "loading") {
    return (
      <Shell>
        <div className="rise-in flex flex-col items-center justify-center gap-4 py-24 text-center">
          <span className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--surface-3)] border-t-[var(--accent)]" />
          <div className="w-full max-w-[260px]">
            <p className="text-[14px] font-semibold">Preparing the pothole detector…</p>
            <p className="mt-1 text-[12px] text-[var(--text-dim)]">
              {detectorPhase === "initializing"
                ? "Starting the detection engine…"
                : typeof detectorProgress === "number"
                  ? `Downloading detection model… ${Math.round(detectorProgress)}%`
                  : "One-time download, cached after this."}
            </p>
            {detectorPhase === "download" && typeof detectorProgress === "number" && (
              <div className="mt-2.5 h-1 w-full overflow-hidden rounded-full bg-[var(--surface-3)]">
                <div
                  className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-200"
                  style={{ width: `${Math.round(detectorProgress)}%` }}
                />
              </div>
            )}
            <p className="mt-2 text-[11px] text-[var(--text-faint)]">
              ~40MB total, once per browser
            </p>
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      {!videoUrl ? (
        <>
          <input
            type="file"
            accept="video/*"
            onChange={onPickVideo}
            className="hidden"
            id="dashcam-video-input"
          />
          <label
            htmlFor="dashcam-video-input"
            className="press active:scale-[0.98] rise-in group relative flex w-full cursor-pointer flex-col items-center justify-center gap-5 overflow-hidden rounded-3xl py-24 shadow-[0_8px_30px_rgba(var(--accent-rgb),0.12)] transition-all hover:shadow-[0_8px_40px_rgba(var(--accent-rgb),0.2)]"
          >
            <div className="absolute inset-0 bg-gradient-to-br from-[var(--surface)] to-[var(--surface-2)]" />
            <div
              className="absolute inset-0 opacity-[0.15] transition-opacity duration-500 group-hover:opacity-30"
              style={{ background: "var(--brand-grad)" }}
            />
            <span
              className="breathe relative grid h-24 w-24 place-items-center rounded-full text-white shadow-[0_0_40px_rgba(var(--accent-rgb),0.4)]"
              style={{ background: "var(--brand-grad)" }}
            >
              <Icon name="video" size={36} />
            </span>
            <div className="relative text-center">
              <span className="block text-xl font-bold tracking-tight">Upload a drive</span>
              <span className="mt-2 block max-w-[30ch] text-[13px] leading-relaxed text-[var(--text-dim)]">
                We&apos;ll scan it for potholes in real time as it plays
              </span>
            </div>
          </label>
          <p className="rise-in mt-4 text-center text-[11px] leading-relaxed text-[var(--text-faint)]">
            Nothing is filed automatically. Tap any captured frame below to review and report it
            through the normal flow.
          </p>
        </>
      ) : (
        <div className="relative w-full overflow-hidden rounded-2xl bg-black">
          {/*
            opacity-0, NOT display:none/hidden — several browsers pause frame
            decoding on a display:none <video>, which left drawImage() painting
            nothing onto the canvas below (confirmed: a black canvas in
            production with the model never even receiving a frame). Staying
            in-layout with zero opacity keeps decoding live while remaining
            fully invisible; the canvas is still the only thing anyone sees.
          */}
          <video
            ref={videoRef}
            src={videoUrl}
            className="absolute inset-0 h-full w-full opacity-0"
            muted
            playsInline
            autoPlay
            onLoadedMetadata={onLoadedMetadata}
            onPlay={onPlay}
            onEnded={onEnded}
          />
          <canvas ref={canvasRef} className="relative block w-full" />
        </div>
      )}

      {videoUrl && (
        <div className="mt-3 flex items-center justify-between">
          <p className="text-[11px] text-[var(--text-faint)]">
            Scanning for potholes… {frames.length} frame{frames.length === 1 ? "" : "s"} captured
          </p>
          <button
            onClick={stopDrive}
            disabled={!driving}
            className="shrink-0 text-[11px] font-medium text-[var(--text-dim)] hover:text-[var(--text)] disabled:opacity-40"
          >
            Stop
          </button>
        </div>
      )}

      {frames.length > 0 && (
        <div className="scroll-thin fade-in mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
          {frames.map((f) => (
            <button
              key={f.id}
              onClick={() => void openFrame(f)}
              className="press group relative aspect-video overflow-hidden rounded-lg border border-[var(--border)] text-left transition-colors hover:border-[var(--accent)]"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={f.snapshotDataUrl}
                alt="Captured pothole"
                className="h-full w-full object-cover"
              />
              <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1.5 py-0.5 text-[9px] text-white">
                {Math.round(f.confidence * 100)}%
              </span>
              <span className="absolute inset-0 flex items-center justify-center bg-black/0 text-[10px] font-semibold text-white opacity-0 transition-all group-hover:bg-black/40 group-hover:opacity-100">
                Report this
              </span>
            </button>
          ))}
        </div>
      )}

      {videoUrl && !driving && (
        <button
          onClick={() => {
            if (videoUrl) URL.revokeObjectURL(videoUrl);
            setVideoUrl(null);
            setFrames([]);
          }}
          className="mt-4 w-full rounded-xl border border-[var(--border)] py-2.5 text-[12px] font-medium text-[var(--text-dim)] hover:border-[var(--border-strong)] hover:text-[var(--text)]"
        >
          Start a new drive
        </button>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="scroll-thin h-full overflow-y-auto px-4 py-5">
      <div className="mx-auto w-full max-w-lg">{children}</div>
    </div>
  );
}
