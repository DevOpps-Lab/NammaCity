"use client";

import { useMemo, useState } from "react";
import { DEMO_SOCIAL_HANDLE } from "@/lib/authorities";
import type { Report } from "@/lib/types";
import { composePost } from "@/lib/escalation";
import Icon from "./Icon";

/**
 * The second refusal. Type a politically charged or corruption-alleging note
 * and watch the composer strip it and explain why, citing the precedent.
 */
export default function EscalationPanel({
  report,
  onClose,
  onPublish,
  onTrace,
}: {
  report: Report;
  onClose: () => void;
  onPublish: (id: string, text: string) => void;
  onTrace: (text: string, status?: "ok" | "warn" | "info") => void;
}) {
  const [note, setNote] = useState("");
  const [variant, setVariant] = useState(0);
  const [published, setPublished] = useState(false);

  const post = useMemo(() => composePost(report, note, variant), [report, note, variant]);

  return (
    <div className="fade-in absolute inset-0 z-40 flex items-end justify-center bg-[var(--scrim)] p-0 backdrop-blur-sm md:items-center md:p-6">
      <div className="sheet-in max-h-[88%] w-full max-w-lg overflow-y-auto scroll-thin rounded-t-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-3)] md:rounded-2xl">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h3 className="text-base font-semibold">Escalate publicly</h3>
            <p className="text-[11px] text-[var(--text-dim)]">
              {report.id} · past its published deadline
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[var(--text-dim)] transition-colors hover:bg-[var(--hover-overlay)] hover:text-[var(--text)]"
          >
            <Icon name="close" size={18} /></button>
        </div>

        <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-[var(--text-dim)]">
          Add a note (optional)
        </label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="Try: 'the corrupt minister ignores our ward'"
          className="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs outline-none placeholder:text-[var(--text-faint)] focus:border-[var(--accent)]"
        />

        {/* --- Guardrail refusals ------------------------------------------ */}
        {post.guard.blocked && (
          <div className="mt-3 rounded-xl border border-[var(--danger)]/30 bg-[var(--danger)]/10 p-3">
            <p className="text-xs font-semibold text-[var(--danger)]">
              Removed {post.guard.violations.length} unsafe element
              {post.guard.violations.length > 1 ? "s" : ""}
            </p>
            <ul className="mt-2 space-y-1.5">
              {post.guard.violations.map((v, i) => (
                <li key={i} className="text-[11px] leading-snug">
                  <span className="rounded bg-[var(--danger)]/20 px-1.5 py-0.5 font-mono text-[var(--danger)]">
                    {v.term}
                  </span>
                  <span className="ml-1.5 text-[var(--text-dim)]">{v.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* --- Preview ------------------------------------------------------ */}
        <p className="mt-4 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-dim)]">
          Post preview
        </p>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
          <p className="whitespace-pre-wrap text-xs leading-relaxed">{post.text}</p>
          <div className="mt-2 grid h-20 place-items-center rounded-lg border border-dashed border-[var(--border-strong)] text-[10px] text-[var(--text-dim)]">
            evidence photo — attached natively, not linked
          </div>
        </div>

        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[var(--text-dim)]">
          <span>✓ facts only, no characterisation</span>
          <span>✓ institution tagged, no named officer</span>
          <span>✓ no link (${post.costUsd.toFixed(3)} vs $0.20)</span>
        </div>

        <button
          onClick={() => setVariant((v) => v + 1)}
          className="mt-3 w-full rounded-lg border border-[var(--border)] px-3 py-2 text-[11px] text-[var(--text-dim)] hover:border-[var(--border-strong)] hover:text-[var(--text)]"
        >
          Rotate template (X forbids substantially similar posts) · variant{" "}
          {(variant % 3) + 1}/3
        </button>

        <div className="mt-4 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 rounded-lg border border-[var(--border)] px-3 py-2.5 text-xs font-semibold hover:border-[var(--border-strong)]"
          >
            Cancel
          </button>
          <button
            disabled={published}
            onClick={() => {
              setPublished(true);
              onPublish(report.id, post.text);
              onTrace(
                `Published to ${DEMO_SOCIAL_HANDLE} · ${report.id} · sandboxed demo account`,
                "ok"
              );
              setTimeout(onClose, 900);
            }}
            className="flex-1 rounded-lg bg-[var(--accent)] px-3 py-2.5 text-xs font-semibold text-[var(--on-accent)] hover:bg-[var(--accent-hover)] disabled:bg-[var(--success)]"
          >
            {published ? "Published ✓" : "Approve & publish"}
          </button>
        </div>

        <p className="mt-2 text-center text-[10px] text-[var(--text-dim)]">
          Sandboxed: posts to our own demo account about seeded data. No real municipal
          handle is tagged during the demo.
        </p>
      </div>
    </div>
  );
}
