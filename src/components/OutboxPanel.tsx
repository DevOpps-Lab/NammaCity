"use client";

import { useState } from "react";
import type { OutboxItem } from "@/lib/outbox";
import Icon from "./Icon";

const KIND_LABEL: Record<OutboxItem["kind"], string> = {
  complaint: "Complaint",
  reply: "Auto-reply",
  post: "Public post",
  rti: "RTI request",
};

// Pitched bright, not 600/700-level: these are label text on a dark chip now,
// so the dark tones that were needed against a pale chip invert the problem and
// sit near 2:1 against the surface.
const KIND_COLOR: Record<OutboxItem["kind"], string> = {
  complaint: "#5b9cf0",
  reply: "var(--violet)",
  post: "var(--danger)",
  rti: "var(--warning)",
};

/**
 * Shows exactly what would be sent, and exactly where it actually went.
 * The intended-vs-actual split is the point: the artifacts are real, the
 * delivery is sandboxed.
 */
export default function OutboxPanel({
  items,
  onClose,
  onCheckInbox,
}: {
  items: OutboxItem[];
  onClose: () => void;
  onCheckInbox?: () => Promise<{ processed?: number } | void>;
}) {
  const [open, setOpen] = useState<string | null>(items[0]?.id ?? null);
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState<string | null>(null);

  const checkInbox = async () => {
    if (!onCheckInbox) return;
    setChecking(true);
    setCheckNote(null);
    try {
      const res = await onCheckInbox();
      const n = (res && "processed" in res && res.processed) || 0;
      setCheckNote(n ? `Processed ${n} reply(ies).` : "No new replies.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="fade-in absolute inset-0 z-40 flex items-end justify-center bg-[var(--scrim)] backdrop-blur-sm md:items-center md:p-6">
      <div className="sheet-in max-h-[90%] w-full max-w-2xl overflow-y-auto scroll-thin rounded-t-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-3)] md:rounded-2xl">
        <div className="mb-1 flex items-start justify-between">
          <h3 className="text-base font-semibold">Outbox</h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[var(--text-dim)] transition-colors hover:bg-[var(--hover-overlay)] hover:text-[var(--text)]"
          >
            <Icon name="close" size={18} /></button>
        </div>
        <p className="mb-3 text-[11px] leading-snug text-[var(--text-dim)]">
          Every message is composed in full, with the correct recipient, cited service standard,
          and a real body, then sent for real to the demo authority mailbox. The intended
          government alias stays visible below; no mail reaches a real government address.
        </p>

        {onCheckInbox && (
          <div className="mb-4 flex items-center gap-2">
            <button
              onClick={checkInbox}
              disabled={checking}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--hover-overlay)] disabled:opacity-50"
            >
              <Icon name="refresh" size={14} />
              {checking ? "Checking…" : "Check inbox for replies"}
            </button>
            {checkNote && (
              <span className="text-[11px] text-[var(--text-dim)]">{checkNote}</span>
            )}
          </div>
        )}

        {items.length === 0 && (
          <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4 text-center text-xs text-[var(--text-dim)]">
            Nothing sent yet. File a report to populate the outbox.
          </p>
        )}

        <div className="space-y-2">
          {items.map((it) => (
            <div
              key={it.id}
              className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-2)]"
            >
              <button
                onClick={() => setOpen(open === it.id ? null : it.id)}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-[var(--hover-overlay)]"
              >
                <span
                  className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider"
                  style={{ background: `${KIND_COLOR[it.kind]}22`, color: KIND_COLOR[it.kind] }}
                >
                  {KIND_LABEL[it.kind]}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs">{it.subject}</span>
                <span className="shrink-0 font-mono text-[10px] text-[var(--text-dim)]">
                  {it.reportId}
                </span>
              </button>

              {open === it.id && (
                <div className="border-t border-[var(--border)] px-3 py-3">
                  <dl className="mb-2 space-y-1 text-[11px]">
                    <div className="flex gap-2">
                      <dt className="w-24 shrink-0 text-[var(--text-dim)]">Intended to</dt>
                      <dd className="font-mono">
                        {it.intendedTo}
                        {!it.recipientVerified && (
                          <span className="ml-1.5 rounded bg-[var(--warning)]/20 px-1 py-0.5 text-[9px] font-semibold text-[var(--warning)]">
                            UNVERIFIED
                          </span>
                        )}
                      </dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-24 shrink-0 text-[var(--text-dim)]">Actually sent</dt>
                      <dd className="font-mono text-[var(--success)]">{it.actuallyTo}</dd>
                    </div>
                  </dl>
                  <pre className="max-h-72 overflow-y-auto scroll-thin whitespace-pre-wrap rounded-lg bg-[var(--surface-2)] p-3 font-mono text-[10px] leading-relaxed text-[var(--text)]">
{it.body}
                  </pre>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
