"use client";

import { useState } from "react";
import type { Report } from "@/lib/types";
import {
  evaluateAfterPhoto,
  VERIFY_SCENARIOS,
  type VerifyResult,
} from "@/lib/verification";
import Icon from "./Icon";

/**
 * The refusal moment. Pick "Still there, detector missed it" and the system
 * declines to close the report even though its own model saw nothing.
 */
export default function VerifyPanel({
  report,
  onClose,
  onConfirmFixed,
  onTrace,
}: {
  report: Report;
  onClose: () => void;
  onConfirmFixed: (id: string) => void;
  onTrace: (text: string, status?: "ok" | "warn" | "info") => void;
}) {
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [scenario, setScenario] = useState<keyof typeof VERIFY_SCENARIOS | null>(null);

  const run = (key: keyof typeof VERIFY_SCENARIOS) => {
    const s = VERIFY_SCENARIOS[key];
    const r = evaluateAfterPhoto(report, {
      placeMatch: s.placeMatch,
      defectConfidence: s.defectConfidence,
    });
    setScenario(key);
    setResult(r);

    onTrace(`After-photo received · place match ${(r.placeMatch * 100).toFixed(0)}%`);
    if (r.verdict === "likely_repaired") {
      onTrace(
        "Detector sees no defect — but recall is ~53%. Evidence, not proof. NOT closing.",
        "warn"
      );
    } else if (r.verdict === "still_present") {
      onTrace("Defect still detected. Report stays open.", "warn");
    } else {
      onTrace("Place match too weak to accept as evidence. Refusing.", "warn");
    }
  };

  return (
    <div className="absolute inset-0 z-40 flex items-end justify-center bg-[var(--scrim)] p-0 backdrop-blur-sm md:items-center md:p-6">
      <div className="max-h-[88%] w-full max-w-lg overflow-y-auto scroll-thin rounded-t-2xl border border-[var(--border)] bg-[var(--surface)] p-5 md:rounded-2xl">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h3 className="text-base font-semibold">Verify the repair</h3>
            <p className="text-[11px] text-[var(--text-dim)]">
              {report.id} · {report.place}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[var(--text-dim)] transition-colors hover:bg-[var(--hover-overlay)] hover:text-[var(--text)]"
          >
            <Icon name="close" size={18} /></button>
        </div>

        {/* Ghost overlay explanation — constrains viewpoint so place matching works */}
        <div className="mb-4 flex gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
          <div className="grid h-16 w-16 shrink-0 place-items-center rounded-lg border border-dashed border-[var(--border-strong)] text-[9px] text-[var(--text-dim)]">
            ghost
          </div>
          <p className="text-[11px] leading-snug text-[var(--text-dim)]">
            Line your shot up with the faded original so we can tell it&apos;s the same
            spot. Same viewpoint makes the comparison meaningful.
          </p>
        </div>

        {!result && (
          <>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-dim)]">
              Simulate an after-photo
            </p>
            <div className="grid gap-2">
              {(Object.keys(VERIFY_SCENARIOS) as (keyof typeof VERIFY_SCENARIOS)[]).map(
                (k) => (
                  <button
                    key={k}
                    onClick={() => run(k)}
                    className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-left text-xs hover:border-[var(--border-strong)]"
                  >
                    {VERIFY_SCENARIOS[k].label}
                    {k === "missed" && (
                      <span className="ml-2 rounded bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700">
                        the hard case
                      </span>
                    )}
                  </button>
                )
              )}
            </div>
          </>
        )}

        {result && (
          <div>
            <div
              className={`rounded-xl border p-3 ${
                result.verdict === "likely_repaired"
                  ? "border-emerald-500/30 bg-emerald-500/10"
                  : "border-red-500/30 bg-red-500/10"
              }`}
            >
              <p
                className={`text-sm font-semibold ${
                  result.verdict === "likely_repaired" ? "text-emerald-700" : "text-red-700"
                }`}
              >
                {result.headline}
              </p>
              <ul className="mt-2 space-y-1">
                {result.reasoning.map((r, i) => (
                  <li key={i} className="text-[11px] leading-snug text-[var(--text-dim)]">
                    · {r}
                  </li>
                ))}
              </ul>
            </div>

            {/* The invariant, stated on screen. */}
            <p className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2.5 text-[11px] leading-snug text-[var(--text-dim)]">
              <strong className="text-[var(--text)]">
                The system never closes a report by itself.
              </strong>{" "}
              Auto-closing on a 53%-accurate model would reproduce the exact fraud this
              product exists to stop.
            </p>

            <div className="mt-4 flex gap-2">
              <button
                onClick={() => {
                  setResult(null);
                  setScenario(null);
                }}
                className="flex-1 rounded-lg border border-[var(--border)] px-3 py-2.5 text-xs font-semibold hover:border-[var(--border-strong)]"
              >
                Try another
              </button>
              <button
                disabled={result.verdict !== "likely_repaired"}
                onClick={() => {
                  onConfirmFixed(report.id);
                  onTrace("Citizen confirmed the repair. Report closed.", "ok");
                  onClose();
                }}
                className="flex-1 rounded-lg bg-[var(--success)] px-3 py-2.5 text-xs font-semibold text-[var(--on-accent)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:bg-[var(--surface-3)] disabled:text-[var(--text-faint)]"
              >
                {result.verdict === "likely_repaired"
                  ? "Yes — it's fixed. Close it."
                  : "Cannot close"}
              </button>
            </div>

            {scenario === "missed" && (
              <p className="mt-2 text-center text-[10px] text-amber-700">
                Note: in this scenario the pothole is still physically there. The model
                missed it — and we still asked you rather than closing.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
