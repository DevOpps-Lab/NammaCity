"use client";

import type { DuplicateCandidate } from "@/lib/dedup";

/**
 * Following FixMyStreet: never silently merge. Show what's already there and
 * let the person decide whether to add their voice or file separately.
 * Five people on one pothole is a far stronger signal than five tickets.
 */
export default function DuplicatePrompt({
  candidates,
  onJoin,
  onFileAnyway,
  onCancel,
}: {
  candidates: DuplicateCandidate[];
  onJoin: (id: string) => void;
  onFileAnyway: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fade-in absolute inset-0 z-50 flex items-end justify-center bg-[var(--scrim)] backdrop-blur-sm md:items-center md:p-6">
      <div className="sheet-in w-full max-w-md rounded-t-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-3)] md:rounded-2xl">
        <h3 className="text-base font-semibold">
          {candidates.length === 1 ? "Someone already reported this" : "Already reported nearby"}
        </h3>
        <p className="mt-1 text-[11px] leading-snug text-[var(--text-dim)]">
          Adding your voice to an existing report carries more weight than a separate
          ticket — and stops the same defect being counted, and closed, twice.
        </p>

        <div className="mt-3 space-y-2">
          {candidates.map((c) => (
            <div
              key={c.report.id}
              className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold">{c.report.place}</p>
                  <p className="font-mono text-[10px] text-[var(--text-dim)]">
                    {c.report.id} · {c.report.supporters} voices
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold ${
                    c.confidence === "high"
                      ? "bg-emerald-500/20 text-emerald-700"
                      : c.confidence === "medium"
                        ? "bg-amber-500/20 text-amber-700"
                        : "bg-[var(--surface-3)] text-[var(--text-dim)]"
                  }`}
                >
                  {c.confidence}
                </span>
              </div>
              <p className="mt-1 text-[10px] text-[var(--text-dim)]">{c.reason}</p>
              <button
                onClick={() => onJoin(c.report.id)}
                className="mt-2 w-full rounded-lg bg-[var(--accent)] px-3 py-2 text-[11px] font-bold text-[var(--on-accent)] hover:bg-[var(--accent-hover)]"
              >
                Add my voice to this
              </button>
            </div>
          ))}
        </div>

        <p className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2 text-[10px] leading-snug text-[var(--text-dim)]">
          Photos taken from different angles won&apos;t always match — a low score
          doesn&apos;t mean it&apos;s a different problem.
        </p>

        <div className="mt-3 flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 rounded-lg border border-[var(--border)] px-3 py-2.5 text-xs font-semibold hover:border-[var(--border-strong)]"
          >
            Cancel
          </button>
          <button
            onClick={onFileAnyway}
            className="flex-1 rounded-lg border border-[var(--border)] px-3 py-2.5 text-xs font-semibold hover:border-[var(--border-strong)]"
          >
            It&apos;s different — file it
          </button>
        </div>
      </div>
    </div>
  );
}
