"use client";

import { useRef, useState } from "react";
import type { Report } from "@/lib/types";
import { evaluateAfterPhoto, VERIFY_SCENARIOS } from "@/lib/verification";
import { processImage, rasterizeForDetection } from "@/lib/imaging";
import { llmAnalyze } from "@/lib/llm-analyze";
import Icon from "./Icon";

/**
 * Verify a repair with a photo. Closure is community-verified: anyone can close
 * a case with a photo that checks out. The check is /api/verify-image (Gemini
 * place-match + defect-resolved); when that's unavailable the resident confirms
 * their own photo manually. Either way a photo is required — that photo is the
 * anti-fraud gate that replaces "only the owner can close".
 */

type Verdict = "likely_repaired" | "still_present" | "inconclusive";

export default function VerifyPanel({
  report,
  isOwner,
  onClose,
  onVerifyClose,
  onTrace,
}: {
  report: Report;
  isOwner: boolean;
  onClose: () => void;
  /** Close the case with this (redacted) after-photo data URL. */
  onVerifyClose: (afterPhotoUrl: string) => void;
  onTrace: (text: string, status?: "ok" | "warn" | "info") => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [afterUrl, setAfterUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [headline, setHeadline] = useState("");
  const [reasons, setReasons] = useState<string[]>([]);
  const [manual, setManual] = useState(false); // Gemini unavailable -> self-attest
  const [attested, setAttested] = useState(false);

  const reset = () => {
    setAfterUrl(null);
    setVerdict(null);
    setHeadline("");
    setReasons([]);
    setManual(false);
    setAttested(false);
  };

  // Real after-photo -> detect faces/plates (Gemini) -> redact on device ->
  // vision check (or manual fallback).
  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true);
    reset();
    try {
      const frame = await rasterizeForDetection(f);
      const det = await llmAnalyze(frame.dataUrl, frame.width, frame.height);
      const img = await processImage(f, {
        faceRegions: det.detection.faces,
        plateRegions: det.detection.plates,
        manualRegions: [],
        detectionOk: det.detection.ran,
      });
      setAfterUrl(img.dataUrl);
      onTrace(
        det.detection.ran
          ? `After-photo redacted (${img.facesFound} face(s), ${img.platesFound} plate(s)). Verifying…`
          : "After-photo could not be auto-checked for faces or plates — review it before closing. Verifying…",
        det.detection.ran ? "info" : "warn"
      );

      let payload: {
        configured?: boolean;
        rateLimited?: boolean;
        verdict?: Verdict;
        placeMatch?: number;
        defectResolved?: number;
        reason?: string;
      } = {};
      try {
        const res = await fetch("/api/verify-image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            afterDataUrl: img.dataUrl,
            beforeUrl: report.photoUrl,
            category: report.category,
          }),
        });
        payload = await res.json();
      } catch {
        payload = { configured: false };
      }

      if (payload.configured === false || payload.rateLimited || !payload.verdict) {
        // No automatic check — fall back to the resident confirming their photo.
        setManual(true);
        setHeadline("Automatic check unavailable — confirm manually");
        setReasons([
          "The vision check is offline or over its daily limit.",
          "Confirm below that this photo shows the repair at the same location.",
        ]);
        onTrace("Vision check unavailable — manual confirmation required.", "warn");
        return;
      }

      const v = payload.verdict;
      setVerdict(v);
      const pm = Math.round((payload.placeMatch ?? 0) * 100);
      const dr = Math.round((payload.defectResolved ?? 0) * 100);
      setReasons([
        `Place match ${pm}% · defect-resolved ${dr}%.`,
        payload.reason || "",
      ].filter(Boolean));
      if (v === "likely_repaired") {
        setHeadline("Looks repaired — confirm to close");
        onTrace(`Verified: place ${pm}%, defect gone ${dr}%.`, "ok");
      } else if (v === "still_present") {
        setHeadline("The defect is still there");
        onTrace("Defect still visible. Cannot close.", "warn");
      } else {
        setHeadline("Can't confirm this is the same place");
        onTrace("Place match too weak. Refusing to close.", "warn");
      }
    } finally {
      setBusy(false);
    }
  };

  // Demo scenarios (no real photo) — exercise the verdict logic on stage.
  const runScenario = (key: keyof typeof VERIFY_SCENARIOS) => {
    const s = VERIFY_SCENARIOS[key];
    const r = evaluateAfterPhoto(report, {
      placeMatch: s.placeMatch,
      defectConfidence: s.defectConfidence,
    });
    setAfterUrl(report.photoUrl); // demo stand-in
    setManual(false);
    setVerdict(r.verdict);
    setHeadline(r.headline);
    setReasons(r.reasoning);
    onTrace(`Simulated after-photo · place match ${(r.placeMatch * 100).toFixed(0)}%`);
  };

  const canClose = afterUrl && (verdict === "likely_repaired" || (manual && attested));

  const close = () => {
    if (!afterUrl) return;
    onVerifyClose(afterUrl);
    onTrace(
      isOwner ? "You confirmed the repair. Case closed." : "You verified another resident's case. Closed.",
      "ok"
    );
    onClose();
  };

  return (
    <div className="fade-in absolute inset-0 z-40 flex items-end justify-center bg-[var(--scrim)] p-0 backdrop-blur-sm md:items-center md:p-6">
      <div className="sheet-in max-h-[88%] w-full max-w-lg overflow-y-auto scroll-thin rounded-t-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-3)] md:rounded-2xl">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h3 className="text-base font-semibold">Verify the repair</h3>
            <p className="text-[11px] text-[var(--text-dim)]">
              {report.id} · {report.place}
              {!isOwner && (
                <span className="ml-1.5 rounded bg-[var(--accent)]/15 px-1.5 py-0.5 text-[9px] font-semibold text-[var(--accent)]">
                  community verification
                </span>
              )}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[var(--text-dim)] transition-colors hover:bg-[var(--hover-overlay)] hover:text-[var(--text)]"
          >
            <Icon name="close" size={18} />
          </button>
        </div>

        {/* preview */}
        {afterUrl && !manual && verdict === null ? null : null}

        {!verdict && !manual && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={onPick}
              className="hidden"
            />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={busy}
              className="flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed border-[var(--border-strong)] py-8 text-[var(--text-dim)] transition-colors hover:border-[var(--accent)] disabled:opacity-50"
            >
              <Icon name="camera" size={24} />
              <span className="text-[13px] font-semibold">
                {busy ? "Checking…" : "Take an after-photo to verify"}
              </span>
              <span className="text-[11px]">Redacted on your device · checked automatically</span>
            </button>

            <p className="my-3 text-center text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
              or simulate (demo)
            </p>
            <div className="grid gap-2">
              {(Object.keys(VERIFY_SCENARIOS) as (keyof typeof VERIFY_SCENARIOS)[]).map((k) => (
                <button
                  key={k}
                  onClick={() => runScenario(k)}
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-left text-xs hover:border-[var(--border-strong)]"
                >
                  {VERIFY_SCENARIOS[k].label}
                  {k === "missed" && (
                    <span className="ml-2 rounded bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700">
                      the hard case
                    </span>
                  )}
                </button>
              ))}
            </div>
          </>
        )}

        {(verdict || manual) && (
          <div>
            {afterUrl && afterUrl.startsWith("data:") && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={afterUrl}
                alt="After"
                className="mb-3 max-h-48 w-full rounded-xl object-cover"
              />
            )}
            <div
              className={`rounded-xl border p-3 ${
                verdict === "likely_repaired" || manual
                  ? "border-emerald-500/30 bg-emerald-500/10"
                  : "border-red-500/30 bg-red-500/10"
              }`}
            >
              <p
                className={`text-sm font-semibold ${
                  verdict === "likely_repaired" || manual ? "text-emerald-700" : "text-red-700"
                }`}
              >
                {headline}
              </p>
              <ul className="mt-2 space-y-1">
                {reasons.map((r, i) => (
                  <li key={i} className="text-[11px] leading-snug text-[var(--text-dim)]">
                    · {r}
                  </li>
                ))}
              </ul>
            </div>

            {manual && (
              <label className="mt-3 flex items-start gap-2 text-[12px] text-[var(--text)]">
                <input
                  type="checkbox"
                  checked={attested}
                  onChange={(e) => setAttested(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  I confirm this photo shows the reported issue repaired, at the same
                  location.
                </span>
              </label>
            )}

            <div className="mt-4 flex gap-2">
              <button
                onClick={reset}
                className="flex-1 rounded-lg border border-[var(--border)] px-3 py-2.5 text-xs font-semibold hover:border-[var(--border-strong)]"
              >
                Try another
              </button>
              <button
                disabled={!canClose}
                onClick={close}
                className="flex-1 rounded-lg bg-[var(--success)] px-3 py-2.5 text-xs font-semibold text-[var(--on-accent)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:bg-[var(--surface-3)] disabled:text-[var(--text-faint)]"
              >
                {canClose ? "It's fixed — close it" : "Cannot close"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
