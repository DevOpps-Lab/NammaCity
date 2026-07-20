"use client";

import { useState } from "react";
import type { Report } from "@/lib/types";
import { STATUS_STYLES } from "@/lib/status";
import { formatRemaining, slaProgress, now } from "@/lib/demoClock";
import type { InboundReply } from "@/lib/correspondence";
import type { Lang } from "@/lib/i18n";
import Icon from "./Icon";
import Correspondence from "./Correspondence";

export default function ReportSheet({
  report,
  lang,
  canAct,
  replies,
  onClose,
  onSupport,
  onRequestVerify,
  onRequestEscalate,
  onReply,
  onFileRti,
}: {
  report: Report;
  lang: Lang;
  /**
   * False when this report belongs to another citizen. The map is community-
   * wide, so anyone can OPEN a report — but verify, escalate, RTI and the
   * correspondence simulator are the owner's alone. RLS enforces this too; the
   * UI just shouldn't offer an action that would be rejected.
   */
  canAct: boolean;
  replies: { label: string; reply: InboundReply }[];
  onClose: () => void;
  onSupport: (id: string) => void;
  onRequestVerify: (r: Report) => void;
  onRequestEscalate: (r: Report) => void;
  onReply: (id: string, reply: InboundReply) => void;
  onFileRti: (r: Report) => void;
}) {
  const [simOpen, setSimOpen] = useState(false);
  const style = STATUS_STYLES[report.status];
  const t = now();
  const progress = Math.min(slaProgress(report.createdAt, report.slaDeadline, t), 1);
  const overdue = t > report.slaDeadline;
  const closed = report.status === "verified_fixed";
  const acting = canAct && !closed;

  // Countdown ring
  const R = 26;
  const C = 2 * Math.PI * R;

  return (
    // pb-safe so the sheet's last action isn't sitting under the home indicator
    // on an iPhone. Inert on desktop, where env() resolves to 0px.
    <div className="pb-safe absolute inset-x-0 bottom-0 z-20 max-h-[72%] overflow-y-auto scroll-thin rounded-t-2xl border-t border-[var(--border)] bg-[var(--surface)] shadow-2xl md:inset-x-auto md:left-4 md:bottom-4 md:max-h-[80%] md:w-[400px] md:rounded-2xl md:border">
      <div className="sticky top-0 flex items-start justify-between gap-3 bg-[var(--surface)] px-5 pt-4 pb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{
                background: style.hollow ? "transparent" : style.color,
                border: `2px ${style.hollow ? "dashed" : "solid"} ${style.color}`,
              }}
            />
            <span className="text-xs font-semibold" style={{ color: style.color }}>
              {style.label}
            </span>
          </div>
          <h3 className="mt-1 truncate text-lg font-semibold">{report.place}</h3>
          <p className="font-mono text-[11px] text-[var(--text-dim)]">
            {report.id} · {report.category.replace(/_/g, " ")} · {report.severity}
          </p>
        </div>

        <button
          onClick={onClose}
          aria-label="Close"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[var(--text-dim)] transition-colors hover:bg-[var(--hover-overlay)] hover:text-[var(--text)]"
          >
            <Icon name="close" size={18} /></button>
      </div>

      <div className="px-5 pb-6">
        {/* --- photo evidence ---------------------------------------------- */}
        {report.photoUrl?.startsWith("data:") && (
          <div className="mb-4 flex gap-2">
            <figure className="min-w-0 flex-1">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={report.photoUrl}
                alt="Reported issue"
                className="h-28 w-full rounded-lg object-cover"
              />
              <figcaption className="mt-1 text-[9px] uppercase tracking-wider text-[var(--text-dim)]">
                Before · redacted on device
              </figcaption>
            </figure>
            {report.afterPhotoUrl?.startsWith("data:") && (
              <figure className="min-w-0 flex-1">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={report.afterPhotoUrl}
                  alt="After repair"
                  className="h-28 w-full rounded-lg object-cover"
                />
                <figcaption className="mt-1 text-[9px] uppercase tracking-wider text-emerald-700">
                  After · citizen verified
                </figcaption>
              </figure>
            )}
          </div>
        )}

        {/* --- SLA ring ---------------------------------------------------- */}
        {!closed && (
          <div className="mb-4 flex items-center gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
            <svg width="64" height="64" viewBox="0 0 64 64" className="shrink-0 -rotate-90">
              <circle cx="32" cy="32" r={R} fill="none" stroke="var(--surface-3)" strokeWidth="6" />
              <circle
                cx="32"
                cy="32"
                r={R}
                fill="none"
                stroke={overdue ? "var(--danger)" : progress > 0.75 ? "var(--warning)" : "var(--success)"}
                strokeWidth="6"
                strokeLinecap="round"
                strokeDasharray={C}
                strokeDashoffset={C * (1 - progress)}
                style={{ transition: "stroke-dashoffset 300ms linear" }}
              />
            </svg>
            <div className="min-w-0">
              <p
                className={`text-sm font-semibold ${overdue ? "text-red-700" : "text-emerald-700"}`}
              >
                {formatRemaining(report.slaDeadline, t)}
              </p>
              <p className="mt-0.5 text-[11px] leading-snug text-[var(--text-dim)]">
                Measured against the authority&apos;s own published deadline — not one we
                invented.
              </p>
            </div>
          </div>
        )}

        {/* --- The claimed-vs-verified distinction -------------------------- */}
        {report.status === "claims_done" && canAct && (
          <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
            <p className="text-xs font-semibold text-amber-700">
              The authority says this is fixed. Nobody has checked.
            </p>
            <p className="mt-1 text-[11px] leading-snug text-amber-900/70">
              We do not close on an authority&apos;s word. Chennai has documented cases of
              complaints closed using photos from a different location.
            </p>
            <button
              onClick={() => onRequestVerify(report)}
              className="mt-2 w-full rounded-lg bg-[var(--warning)] px-3 py-2 text-xs font-semibold text-[var(--on-accent)] hover:brightness-110"
            >
              Submit an after-photo to verify
            </button>
          </div>
        )}

        {/* --- Filed to ----------------------------------------------------- */}
        <div className="mb-4">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-dim)]">
            Filed to
          </p>
          <div className="space-y-1">
            {report.filedTo.map((a) => (
              <div
                key={a}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs"
              >
                {a}
              </div>
            ))}
          </div>
          {report.filedTo.length > 1 && (
            <p className="mt-1.5 text-[11px] leading-snug text-[var(--text-dim)]">
              Filed to multiple agencies simultaneously rather than guessing one owner.
              Bombay HC (13 Oct 2025) forbids agencies creating &ldquo;no-man&apos;s
              zones&rdquo; of responsibility.
            </p>
          )}
        </div>

        {/* --- Timeline ----------------------------------------------------- */}
        <div className="mb-4">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-dim)]">
            Timeline
          </p>
          <ol className="space-y-2 border-l border-[var(--border)] pl-3">
            {report.timeline.map((e, i) => (
              <li key={i} className="relative">
                <span className="absolute -left-[17px] top-1.5 h-1.5 w-1.5 rounded-full bg-[var(--text-dim)]" />
                <p className="text-xs">{e.detail}</p>
                <p className="text-[10px] text-[var(--text-dim)]">
                  {new Date(e.at).toLocaleString("en-IN", {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
              </li>
            ))}
          </ol>
        </div>

        {/* --- Escalation ladder -------------------------------------------- */}
        {overdue && acting && (
          <div className="mb-3 space-y-2">
            <button
              onClick={() => onFileRti(report)}
              className="w-full rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs font-semibold text-amber-700 hover:bg-amber-500/20"
            >
              Draft RTI status request
              <span className="ml-1 font-normal text-amber-800/70">
                · RTI Act s.4(1)(b)
              </span>
            </button>
            {report.status !== "escalated" && (
              <button
                onClick={() => onRequestEscalate(report)}
                className="w-full rounded-lg bg-[var(--danger)] px-3 py-2.5 text-xs font-semibold text-[var(--on-accent)] hover:brightness-110"
              >
                Escalate publicly — deadline missed
              </button>
            )}
          </div>
        )}

        {report.status === "escalated" && (
          <div className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 p-2.5">
            <p className="text-[11px] font-semibold text-red-700">
              Published to the public ledger
            </p>
            <p className="mt-0.5 text-[10px] text-red-900/70">
              Facts only · institution tagged · no named officer
            </p>
          </div>
        )}

        {/* --- Actions ------------------------------------------------------
            Supporting works on ANY report you can see. Verifying does not:
            only the citizen who filed one can move it toward closure, so the
            button is simply absent rather than present-and-failing. */}
        <div className="flex gap-2">
          <button
            onClick={() => onSupport(report.id)}
            className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-xs font-semibold transition-colors hover:border-[var(--border-strong)]"
          >
            {canAct ? "Me too" : "Back this report"} · {report.supporters}
          </button>
          {acting && (
            <button
              onClick={() => onRequestVerify(report)}
              className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-xs font-semibold transition-colors hover:border-[var(--border-strong)]"
            >
              I walked past
            </button>
          )}
        </div>

        {!canAct && (
          <p className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2.5 text-[11px] leading-relaxed text-[var(--text-dim)]">
            Another resident filed this. You can add your voice, but only they
            can confirm it fixed — that is the whole point of the ledger.
          </p>
        )}

        {closed && (
          <p className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2.5 text-center text-xs text-emerald-700">
            Verified fixed by a citizen. This is the only way a report closes here.
          </p>
        )}

        {/* --- Correspondence: the evidence behind the status --------------- */}
        <div className="mt-4 border-t border-[var(--border)] pt-3">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-dim)]">
            Correspondence
          </p>
          <Correspondence reportId={report.id} />
        </div>

        {/* --- Correspondence simulator ------------------------------------ */}
        {acting && (
          <div className="mt-4 border-t border-[var(--border)] pt-3">
            <button
              onClick={() => setSimOpen((v) => !v)}
              className="flex w-full items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-[var(--text-dim)] hover:text-[var(--text)]"
            >
              <span>Simulate a reply from the authority</span>
              <span>{simOpen ? "−" : "+"}</span>
            </button>

            {simOpen && (
              <div className="mt-2 space-y-1.5">
                {replies.map((r) => (
                  <button
                    key={r.label}
                    onClick={() => onReply(report.id, r.reply)}
                    className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-left text-[11px] hover:border-[var(--border-strong)]"
                  >
                    {r.label}
                    {r.label.includes("transfer") && (
                      <span className="ml-1.5 rounded bg-purple-500/20 px-1.5 py-0.5 text-[9px] font-semibold text-purple-700">
                        clock keeps running
                      </span>
                    )}
                    {r.label.includes("Claims") && (
                      <span className="ml-1.5 rounded bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-semibold text-amber-700">
                        won&apos;t close it
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
