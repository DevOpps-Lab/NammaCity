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

// 600/700-level: these are used as label text on a pale chip, where the
// original 400-level values sat around 2:1 on white.
const KIND_COLOR: Record<OutboxItem["kind"], string> = {
  complaint: "#0369a1",
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
}: {
  items: OutboxItem[];
  onClose: () => void;
}) {
  const [open, setOpen] = useState<string | null>(items[0]?.id ?? null);

  return (
    <div className="absolute inset-0 z-40 flex items-end justify-center bg-[var(--scrim)] backdrop-blur-sm md:items-center md:p-6">
      <div className="max-h-[90%] w-full max-w-2xl overflow-y-auto scroll-thin rounded-t-2xl border border-[var(--border)] bg-[var(--surface)] p-5 md:rounded-2xl">
        <div className="mb-1 flex items-start justify-between">
          <h3 className="text-base font-semibold">Outbox</h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[var(--text-dim)] transition-colors hover:bg-[var(--hover-overlay)] hover:text-[var(--text)]"
          >
            <Icon name="close" size={18} /></button>
        </div>
        <p className="mb-4 text-[11px] leading-snug text-[var(--text-dim)]">
          Every message is composed in full — correct recipient, cited service standard,
          real body — then routed to a sandbox. Nothing reaches a government address.
        </p>

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
                          <span className="ml-1.5 rounded bg-amber-500/20 px-1 py-0.5 text-[9px] font-semibold text-amber-700">
                            UNVERIFIED
                          </span>
                        )}
                      </dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-24 shrink-0 text-[var(--text-dim)]">Actually sent</dt>
                      <dd className="font-mono text-emerald-700">{it.actuallyTo}</dd>
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
