"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { rasterizeForDetection } from "@/lib/imaging";
import Icon from "./Icon";

/**
 * AFTER-PHOTO SUBMISSION FROM THE PUBLIC TRACKING PAGE.
 *
 * The counterpart to VerifyPanel, for someone with no account. Two differences,
 * both deliberate:
 *
 *  1. No manual-confirm fallback. VerifyPanel lets a signed-in resident attest
 *     to their own photo when Gemini is unavailable; a bearer token is not an
 *     identity, so here the machine check is the only way through. The server
 *     enforces this — this component just explains it.
 *
 *  2. Redaction is SERVER-SIDE. This page is public, so it cannot reach the
 *     auth-gated detection call; it sends a downscaled, EXIF-stripped frame and
 *     `/api/track/verify` detects + pixelates faces and number plates before the
 *     photo is stored (the same path the WhatsApp intake uses). The preview is
 *     hidden until the server responds so the un-redacted frame is never shown.
 */

interface Outcome {
  closed: boolean;
  reason: string;
  headline: string;
  detail: string;
  placeMatch?: number;
  defectResolved?: number;
}

export default function TrackVerify({ token }: { token: string }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"preparing" | "checking" | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const pick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Clear immediately so picking the same file twice still fires onChange.
    e.target.value = "";
    if (!file) return;

    setOutcome(null);
    setBusy("preparing");
    try {
      const frame = await rasterizeForDetection(file);
      setBusy("checking");

      const res = await fetch("/api/track/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, afterDataUrl: frame.dataUrl }),
      });
      const body = await res.json().catch(() => null);

      if (!body || typeof body.headline !== "string") {
        setOutcome({
          closed: false,
          reason: "error",
          headline: "That didn't go through",
          detail:
            body?.error ??
            "Something went wrong on our side. Your report is unchanged. Please try again.",
        });
        return;
      }

      setOutcome(body as Outcome);
      // The page is force-dynamic and server-rendered, so a refresh is what
      // repaints the status chip, the timeline and the after-photo.
      if (body.closed) router.refresh();
    } catch {
      setOutcome({
        closed: false,
        reason: "error",
        headline: "We couldn't read that photo",
        detail: "Try again with a different picture. Nothing was changed.",
      });
    } finally {
      setBusy(null);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-[13px] font-semibold text-[var(--on-accent)]"
        style={{ background: "var(--brand-grad)" }}
      >
        <Icon name="camera" size={16} />
        It&apos;s fixed, send an after-photo
      </button>
    );
  }

  return (
    <div className="card mt-3 rounded-2xl border border-[var(--border)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[13px] font-bold leading-tight">Verify the repair</p>
          <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-dim)]">
            Photograph the same spot. We compare it with the original for same place,
            problem gone, and close the report if it checks out.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Cancel"
          className="shrink-0 rounded-lg p-1 text-[var(--text-faint)]"
        >
          <Icon name="close" size={16} />
        </button>
      </div>

      {busy && (
        <p className="mt-3 text-[12px] font-medium text-[var(--text-dim)]">
          {busy === "preparing"
            ? "Preparing your photo…"
            : "Checking the photo and comparing with the original…"}
        </p>
      )}

      {!busy && !outcome && (
        <p className="mt-2 text-[11px] text-[var(--text-dim)]">
          Faces and number plates are covered on our server before the photo is
          stored or shown.
        </p>
      )}

      {outcome && (
        <div
          className="mt-3 rounded-xl border px-3 py-2.5"
          style={{
            borderColor: outcome.closed ? "var(--success, #4fae7c)" : "var(--border)",
          }}
        >
          <p className="flex items-center gap-1.5 text-[12px] font-semibold">
            {outcome.closed && <Icon name="check" size={14} />}
            {outcome.headline}
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-dim)]">
            {outcome.detail}
          </p>
          {/* Show the numbers behind a refusal rather than only the verdict —
              a citizen told "wrong place" deserves to see how close it was. */}
          {typeof outcome.placeMatch === "number" && (
            <p className="mt-1.5 text-[10px] text-[var(--text-faint)]">
              Place match {(outcome.placeMatch * 100).toFixed(0)}% · defect resolved{" "}
              {((outcome.defectResolved ?? 0) * 100).toFixed(0)}%
            </p>
          )}
        </div>
      )}

      {!outcome?.closed && (
        <>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={pick}
            className="hidden"
          />
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => fileRef.current?.click()}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-[13px] font-semibold text-[var(--on-accent)] disabled:opacity-50"
            style={{ background: "var(--brand-grad)" }}
          >
            <Icon name="camera" size={16} />
            {outcome ? "Try another photo" : "Take or choose a photo"}
          </button>
        </>
      )}
    </div>
  );
}
