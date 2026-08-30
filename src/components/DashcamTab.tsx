"use client";

/**
 * DASHCAM MODE
 *
 * Upload a drive video; it is scanned for potholes on-device by a YOLOv8n model
 * (onnxruntime-web), and every hit lands in a Draft Queue for review.
 *
 * WHY THIS SCANS INSTEAD OF PLAYING. The obvious implementation — play the
 * video and run inference from a requestAnimationFrame loop — is what this
 * replaced, and it failed on exactly the footage the feature is for. Inference
 * takes ~600ms on the wasm path, so at 1x playback of 30fps footage roughly
 * one frame in eighteen was ever analysed (~6% of the video). On slow close-up
 * clips that was invisible, because the pothole filled the frame for seconds.
 * On real dashcam footage a pothole is in view for about a second, got one or
 * two chances, and was usually missed. The boxes were also ~600ms stale, so
 * they were painted where the pothole had been.
 *
 * Since this is an uploaded file and not a live camera, nothing requires 1x
 * playback. So the video is kept PAUSED and stepped deterministically: seek,
 * analyse, draw, advance. Every sampled frame is really analysed, and the boxes
 * always belong to the frame on screen. It looks like slightly slow live
 * detection and is exhaustive underneath.
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
  detectPotholesRemote,
  remoteDetectorAvailable,
  CONF_THRESHOLD,
  CONF_MIN,
  CONF_MAX,
  type DashcamDetection,
  type DetectorProgress,
} from "@/lib/dashcam-detect";
import {
  DEFAULT_ROI,
  ROI_HORIZON_MAX,
  ROI_HORIZON_MIN,
  ROI_TOP_MAX,
  ROI_TOP_MIN,
  roiCorners,
  type Roi,
} from "@/lib/roi";

interface DraftFrame {
  id: string;
  capturedAtMs: number;
  snapshotDataUrl: string;
  confidence: number;
  classLabel: string;
}

/**
 * Roughly how many frames to sample across the whole clip. Sampling adapts to
 * clip length so scan time stays bounded instead of scaling without limit: a
 * 15s clip lands on ~0.25s steps, a 2min clip on 1s steps.
 */
const TARGET_SAMPLES = 60;
const MIN_STEP_S = 0.15;
const MAX_STEP_S = 1.0;

/**
 * Minimum gap between captures, in VIDEO seconds — not wall clock. The old code
 * throttled on performance.now(), which stops corresponding to anything once
 * playback is decoupled from real time.
 */
const CAPTURE_MIN_GAP_S = 1.0;

/** A seek to an unchanged timestamp may never fire `seeked`; never hang on it. */
const SEEK_TIMEOUT_MS = 400;

/** Resolves once the frame at `t` is actually decoded and drawable. */
function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    // Idempotent, so the timeout firing after a real `seeked` is harmless.
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener("seeked", finish);
      resolve();
    };
    video.addEventListener("seeked", finish);
    setTimeout(finish, SEEK_TIMEOUT_MS);
    video.currentTime = t;
  });
}

interface ScanProgress {
  done: number;
  total: number;
  etaMs: number | null;
}

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

  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [frames, setFrames] = useState<DraftFrame[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanDone, setScanDone] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [sensitivity, setSensitivity] = useState(CONF_THRESHOLD);
  /**
   * The road-ahead trapezoid. ON by default because the failure it fixes is the
   * one people actually hit — a dry run flagged the roadside tree line as
   * potholes, with boxes covering a third of the frame. Off is one click, and
   * close-up footage needs it: a clip shot standing over a pothole has no
   * horizon, so a road wedge would discard the subject.
   */
  const [roiOn, setRoiOn] = useState(true);
  const [roi, setRoi] = useState<Roi>(DEFAULT_ROI);
  /**
   * The server-side ensemble, when the sidecar is running. Off unless it is
   * both available and chosen: it uploads a JPEG per frame, which is a real
   * cost on mobile data and not one to impose by default.
   */
  const [remoteAvailable, setRemoteAvailable] = useState(false);
  const [useRemote, setUseRemote] = useState(false);
  const [remoteModels, setRemoteModels] = useState<string[]>([]);
  /** Set when a frame silently fell back, so the UI can stop claiming the ensemble. */
  const [remoteFellBack, setRemoteFellBack] = useState(false);
  const useRemoteRef = useRef(false);
  useEffect(() => {
    useRemoteRef.current = useRemote;
  }, [useRemote]);
  useEffect(() => {
    let alive = true;
    void remoteDetectorAvailable().then((r) => {
      if (!alive) return;
      setRemoteAvailable(r.available);
      setRemoteModels(r.models);
    });
    return () => {
      alive = false;
    };
  }, []);

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
  /** Bumped to abandon an in-flight scan (Stop, new video, unmount). */
  const runIdRef = useRef(0);
  /** Read inside the loop so the slider takes effect on the next frame. */
  const sensitivityRef = useRef(sensitivity);
  /**
   * Same mirror-ref treatment for the ROI. runScan's dependency array is
   * deliberately narrow so the callback stays stable for the length of a clip;
   * reading this state directly would rebuild it and abandon the scan every
   * time the slider moved.
   */
  const roiRef = useRef<Roi | null>(roiOn ? roi : null);

  useEffect(() => {
    sensitivityRef.current = sensitivity;
  }, [sensitivity]);

  useEffect(() => {
    roiRef.current = roiOn ? roi : null;
  }, [roiOn, roi]);

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

  useEffect(() => {
    // Capture the ref object (not its value) so the cleanup bumps the live
    // counter and abandons whatever scan is in flight at unmount.
    const runId = runIdRef;
    return () => {
      runId.current++;
    };
  }, []);

  /**
   * Dims everything the model is not looking at and outlines the wedge.
   *
   * Worth the pixels: with the ROI on, anything outside this shape cannot be
   * detected, and a detector that silently ignores most of the frame is a
   * support problem. Showing it turns "why did it miss that" into an answer.
   *
   * Drawn on the VISIBLE canvas only. Painting it onto the clean frame would
   * feed the outline back into the next inference and burn it into the photo a
   * report is filed with — see the comment on frameRef.
   */
  const drawRoi = useCallback((ctx: CanvasRenderingContext2D, area: Roi | null) => {
    if (!area) return;
    const { width: w, height: h } = ctx.canvas;
    const corners = roiCorners(area, w, h);

    ctx.save();
    // Even-odd against a full-frame rect punches the trapezoid out of the dim.
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.moveTo(corners[0][0], corners[0][1]);
    for (const [x, y] of corners.slice(1)) ctx.lineTo(x, y);
    ctx.closePath();
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fill("evenodd");

    ctx.beginPath();
    ctx.moveTo(corners[0][0], corners[0][1]);
    for (const [x, y] of corners.slice(1)) ctx.lineTo(x, y);
    ctx.closePath();
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = Math.max(1.5, w / 480);
    ctx.setLineDash([w / 80, w / 120]);
    ctx.stroke();
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

  const captureFrame = useCallback(
    (clean: HTMLCanvasElement, d: DashcamDetection, atMs: number) => {
      setFrames((prev) => [
        {
          id: crypto.randomUUID(),
          capturedAtMs: atMs,
          // From the CLEAN canvas — this image becomes the filed report's
          // photo, so it must not carry detection overlays.
          snapshotDataUrl: clean.toDataURL("image/jpeg", 0.85),
          confidence: d.confidence,
          classLabel: d.classLabel,
        },
        ...prev,
      ]);
    },
    []
  );

  /** Steps the whole clip: seek -> analyse -> draw -> advance. */
  const runScan = useCallback(async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const clean = frameRef.current;
    const ctx = canvas?.getContext("2d");
    const cctx = clean?.getContext("2d");
    if (!video || !canvas || !clean || !ctx || !cctx) return;

    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      setScanError("Couldn't read this video's length, so it can't be scanned. Try another file.");
      return;
    }

    const runId = ++runIdRef.current;
    const aborted = () => runIdRef.current !== runId;

    video.pause();
    setScanError(null);
    setScanDone(false);
    setScanning(true);

    const step = Math.min(MAX_STEP_S, Math.max(MIN_STEP_S, duration / TARGET_SAMPLES));
    const total = Math.max(1, Math.ceil(duration / step));
    setProgress({ done: 0, total, etaMs: null });

    const startedAt = performance.now();
    let lastCaptureAt = -Infinity;
    let done = 0;

    for (let t = 0; t < duration; t += step) {
      if (aborted()) return;
      await seekTo(video, Math.min(t, Math.max(0, duration - 0.01)));
      if (aborted()) return;

      cctx.drawImage(video, 0, 0, clean.width, clean.height);

      // Remote first when asked for, local otherwise — and local ALSO when the
      // sidecar returns null, which it does for every failure. A scan must not
      // die because a Python service restarted mid-video.
      // Both paths get the same ROI, so switching detectors mid-clip cannot
      // change which part of the road is under examination.
      const area = roiRef.current;
      let detections: DashcamDetection[] | null = null;
      if (useRemoteRef.current) {
        detections = await detectPotholesRemote(clean, {
          threshold: sensitivityRef.current,
          roi: area,
        });
        if (detections === null) setRemoteFellBack(true);
      }
      if (detections === null) {
        detections = await detectPotholes(clean, {
          threshold: sensitivityRef.current,
          roi: area,
        });
      }
      if (aborted()) return;

      // Draw the frame we just analysed, with its own boxes — never a previous
      // frame's, which is what made the old real-time overlay look misaligned.
      ctx.drawImage(clean, 0, 0);
      drawRoi(ctx, area);
      drawBoxes(ctx, detections);

      const best = detections.reduce<DashcamDetection | null>(
        (top, d) => (!top || d.confidence > top.confidence ? d : top),
        null
      );
      if (best && t - lastCaptureAt >= CAPTURE_MIN_GAP_S) {
        lastCaptureAt = t;
        captureFrame(clean, best, t * 1000);
      }

      done++;
      const perFrame = (performance.now() - startedAt) / done;
      setProgress({ done, total, etaMs: Math.max(0, (total - done) * perFrame) });
    }

    if (aborted()) return;
    setScanning(false);
    setScanDone(true);
  }, [captureFrame, drawBoxes, drawRoi]);

  const onPickVideo = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    runIdRef.current++; // abandon any scan still running
    const url = URL.createObjectURL(f);
    setVideoUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return url;
    });
    setFrames([]);
    setProgress(null);
    setScanDone(false);
    setScanError(null);
    setScanning(false);
  }, []);

  /** Metadata is the earliest point the real dimensions and duration exist. */
  const onLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    // Clean offscreen twin, same dimensions. Built fresh rather than resized
    // in place, so nothing read out of the ref is mutated.
    const clean = document.createElement("canvas");
    clean.width = video.videoWidth;
    clean.height = video.videoHeight;
    frameRef.current = clean;

    void runScan();
  }, [runScan]);

  const stopScan = useCallback(() => {
    runIdRef.current++;
    setScanning(false);
    setScanDone(true);
  }, []);

  const newDrive = useCallback(() => {
    runIdRef.current++;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl(null);
    setFrames([]);
    setProgress(null);
    setScanning(false);
    setScanDone(false);
    setScanError(null);
  }, [videoUrl]);

  const openFrame = useCallback(
    async (frame: DraftFrame) => {
      const blob = await (await fetch(frame.snapshotDataUrl)).blob();
      const file = new File([blob], `dashcam-${frame.id}.jpg`, { type: blob.type });
      onOpenReport(file);
    },
    [onOpenReport]
  );

  // ------------------------------------------------------------- detector
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

  // ------------------------------------------------------------------ idle
  if (!videoUrl) {
    return (
      <Shell>
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
              Every frame is scanned for potholes, on your device
            </span>
          </div>
        </label>
        <p className="rise-in mt-4 text-center text-[11px] leading-relaxed text-[var(--text-faint)]">
          Nothing is filed automatically. Tap any captured frame to review and report it through
          the normal flow.
        </p>
      </Shell>
    );
  }

  // ---------------------------------------------------------------- scanning
  const pct = progress ? Math.round((progress.done / progress.total) * 100) : 0;
  const etaSec = progress?.etaMs != null ? Math.ceil(progress.etaMs / 1000) : null;

  return (
    <Shell>
      <div className="relative w-full overflow-hidden rounded-2xl bg-black">
        {/*
          opacity-0, NOT display:none/hidden — several browsers pause frame
          decoding on a display:none <video>, which left drawImage() painting
          nothing onto the canvas below (confirmed: a black canvas in
          production with the model never even receiving a frame). Staying
          in-layout with zero opacity keeps decoding live while remaining
          fully invisible; the canvas is still the only thing anyone sees.

          No autoPlay: the scan drives currentTime itself and the video stays
          paused throughout.
        */}
        <video
          ref={videoRef}
          src={videoUrl}
          className="absolute inset-0 h-full w-full opacity-0"
          muted
          playsInline
          preload="auto"
          onLoadedMetadata={onLoadedMetadata}
        />
        <canvas ref={canvasRef} className="relative block w-full" />
      </div>

      {scanError && (
        <p className="mt-3 rounded-lg border border-[var(--danger)]/35 bg-[var(--danger)]/10 px-3 py-2 text-[11px] leading-relaxed text-[var(--danger)]">
          {scanError}
        </p>
      )}

      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-[11px] text-[var(--text-faint)]">
          {scanning ? (
            <>
              Scanning {pct}% · frame {progress?.done ?? 0}/{progress?.total ?? 0}
              {etaSec != null && etaSec > 0 ? ` · ~${etaSec}s left` : ""}
            </>
          ) : scanDone ? (
            <>
              Scan complete · {frames.length} pothole{frames.length === 1 ? "" : "s"} captured
            </>
          ) : (
            "Preparing scan…"
          )}
        </p>
        {scanning ? (
          <button
            onClick={stopScan}
            className="shrink-0 text-[11px] font-medium text-[var(--text-dim)] hover:text-[var(--text)]"
          >
            Stop
          </button>
        ) : (
          <div className="flex shrink-0 gap-3">
            <button
              onClick={() => void runScan()}
              className="text-[11px] font-medium text-[var(--accent)] hover:underline"
            >
              Rescan
            </button>
            <button
              onClick={newDrive}
              className="text-[11px] font-medium text-[var(--text-dim)] hover:text-[var(--text)]"
            >
              New drive
            </button>
          </div>
        )}
      </div>

      {scanning && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-[var(--surface-3)]">
          <div
            className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-150"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      {/* The road area is adjustable rather than fixed because the right wedge
          depends on how the camera is mounted — height, tilt and lens all move
          the horizon. Swept across three clips, no single trapezoid was best
          for all of them, so a hardcoded one would be wrong for some mountings
          with no way to correct it. */}
      <label className="mt-4 flex items-start gap-2.5 rounded-xl border border-[var(--border)] p-3">
        <input
          type="checkbox"
          checked={roiOn}
          onChange={(e) => setRoiOn(e.target.checked)}
          className="mt-0.5 accent-[var(--accent)]"
        />
        <span className="text-[11px] leading-relaxed">
          <span className="font-medium">Look at the road only</span>
          <span className="mt-0.5 block text-[var(--text-faint)]">
            Analyses just the shaded wedge ahead of the car. Roadside trees and shadows are the
            main source of wrong boxes, and they sit outside it. Turn this off for close-up clips
            filmed standing over a pothole — those have no horizon, so the wedge would cut out the
            subject.
          </span>
        </span>
      </label>

      {roiOn && (
        <div className="mt-2 grid gap-3 rounded-xl border border-[var(--border)] p-3">
          <label className="block">
            <span className="flex items-baseline justify-between text-[11px] text-[var(--text-dim)]">
              <span className="font-medium">Horizon</span>
              <span className="text-[var(--text-faint)]">
                {Math.round(roi.horizon * 100)}% down the frame
              </span>
            </span>
            <input
              type="range"
              min={ROI_HORIZON_MIN}
              max={ROI_HORIZON_MAX}
              step={0.05}
              value={roi.horizon}
              onChange={(e) => setRoi((r) => ({ ...r, horizon: Number(e.target.value) }))}
              className="mt-1.5 w-full accent-[var(--accent)]"
            />
          </label>
          <label className="block">
            <span className="flex items-baseline justify-between text-[11px] text-[var(--text-dim)]">
              <span className="font-medium">Width at the horizon</span>
              <span className="text-[var(--text-faint)]">{Math.round(roi.topHalf * 200)}%</span>
            </span>
            <input
              type="range"
              min={ROI_TOP_MIN}
              max={ROI_TOP_MAX}
              step={0.02}
              value={roi.topHalf}
              onChange={(e) => setRoi((r) => ({ ...r, topHalf: Number(e.target.value) }))}
              className="mt-1.5 w-full accent-[var(--accent)]"
            />
            <span className="mt-1 block text-[10px] leading-relaxed text-[var(--text-faint)]">
              Takes effect on the next frame — adjust mid-scan and watch the shaded area move.
            </span>
          </label>
        </div>
      )}

      {/* Sensitivity is exposed because the right value is footage-dependent:
          a distant pothole in wide footage scores far lower than a close-up
          one, and a captured frame still faces Gemini classification and human
          confirmation downstream, so leaning toward recall is cheap. */}
      <label className="mt-4 block">
        <span className="flex items-baseline justify-between text-[11px] text-[var(--text-dim)]">
          <span className="font-medium">Sensitivity</span>
          <span className="text-[var(--text-faint)]">
            {Math.round(sensitivity * 100)}% · {sensitivity <= 0.22 ? "catches more, more false alarms" : sensitivity >= 0.45 ? "stricter, may miss some" : "balanced"}
          </span>
        </span>
        <input
          type="range"
          min={CONF_MIN}
          max={CONF_MAX}
          step={0.05}
          value={sensitivity}
          onChange={(e) => setSensitivity(Number(e.target.value))}
          className="mt-1.5 w-full accent-[var(--accent)]"
        />
        <span className="mt-1 block text-[10px] leading-relaxed text-[var(--text-faint)]">
          Takes effect on the next frame — adjust mid-scan, or Rescan to redo the clip.
        </span>
      </label>

      {/* Only offered when the sidecar answers. An option that silently does
          nothing is worse than no option. */}
      {remoteAvailable && (
        <label className="mt-3 flex items-start gap-2.5 rounded-xl border border-[var(--border)] p-3">
          <input
            type="checkbox"
            checked={useRemote}
            onChange={(e) => {
              setUseRemote(e.target.checked);
              setRemoteFellBack(false);
            }}
            className="mt-0.5 accent-[var(--accent)]"
          />
          <span className="text-[11px] leading-relaxed">
            <span className="font-medium">Higher accuracy (server)</span>
            <span className="mt-0.5 block text-[var(--text-faint)]">
              Runs {remoteModels.length || 2} detection models and merges the results. The two
              disagree usefully — one is better on phone footage, the other on wide dashcam
              video. Uploads one image per frame, so it uses mobile data.
            </span>
            {remoteFellBack && (
              <span className="mt-1 block text-[var(--warning)]">
                The server didn&apos;t answer for at least one frame — those were scanned on
                your device instead.
              </span>
            )}
          </span>
        </label>
      )}

      {frames.length > 0 && (
        <div className="scroll-thin fade-in mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4">
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
                {Math.round(f.confidence * 100)}% · {(f.capturedAtMs / 1000).toFixed(1)}s
              </span>
              <span className="absolute inset-0 flex items-center justify-center bg-black/0 text-[10px] font-semibold text-white opacity-0 transition-all group-hover:bg-black/40 group-hover:opacity-100">
                Report this
              </span>
            </button>
          ))}
        </div>
      )}

      {scanDone && frames.length === 0 && (
        <p className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-center text-[12px] leading-relaxed text-[var(--text-dim)]">
          No potholes found in this clip. If you can see one, raise the sensitivity above and
          Rescan — distant potholes in wide footage score low.
        </p>
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
