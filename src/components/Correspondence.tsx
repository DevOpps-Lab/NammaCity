"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { fetchThread, type ThreadEntry } from "@/lib/db";

const KIND_LABEL: Record<string, string> = {
  complaint: "Complaint filed",
  reply: "Our reply",
  post: "Published",
  rti: "RTI request",
  acknowledged: "Acknowledged",
  query: "Query",
  jurisdiction_transfer: "Jurisdiction transfer",
  claims_done: "Claims done",
  rejected: "Rejected",
};

/**
 * The full correspondence with the authorities on one report — what we sent and
 * what came back, in order.
 *
 * This is the evidence behind a status. A report reading "transferred" is a
 * claim; the transfer email that caused it is the proof, and until now it was
 * classified and then discarded.
 */
export default function Correspondence({ reportId }: { reportId: string }) {
  const [entries, setEntries] = useState<ThreadEntry[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    fetchThread(supabase, reportId)
      .then((t) => !cancelled && setEntries(t))
      .catch(() => !cancelled && setEntries([]));
    return () => {
      cancelled = true;
    };
  }, [reportId]);

  if (entries === null) {
    return <p className="text-[11px] text-[var(--text-faint)]">Loading correspondence…</p>;
  }

  if (entries.length === 0) {
    return (
      <p className="text-[11px] leading-relaxed text-[var(--text-faint)]">
        Nothing sent yet. Seeded reports arrive without correspondence. File a
        new report, or simulate a reply below, to populate this thread.
      </p>
    );
  }

  return (
    <ol className="space-y-1.5">
      {entries.map((e) => {
        const inbound = e.direction === "inbound";
        const isOpen = open === e.id;
        return (
          <li
            key={e.id}
            className={`overflow-hidden rounded-lg border ${
              inbound
                ? "border-[var(--border)] bg-[var(--surface-2)]"
                : "border-[var(--accent)]/25 bg-[var(--accent)]/5"
            }`}
          >
            <button
              onClick={() => setOpen(isOpen ? null : e.id)}
              className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
            >
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${
                  inbound
                    ? "bg-[var(--surface-3)] text-[var(--text-dim)]"
                    : "bg-[var(--accent)]/15 text-[var(--accent)]"
                }`}
              >
                {inbound ? "In" : "Out"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] font-medium">
                  {KIND_LABEL[e.kind] ?? e.kind}
                </span>
                <span className="block truncate text-[10px] text-[var(--text-dim)]">
                  {inbound ? "from" : "to"} {e.who}
                </span>
              </span>
              <span className="shrink-0 text-[9px] tabular-nums text-[var(--text-faint)]">
                {new Date(e.at).toLocaleDateString("en-IN", {
                  day: "numeric",
                  month: "short",
                })}
              </span>
            </button>

            {isOpen && (
              <div className="fade-in border-t border-[var(--border)] px-2.5 py-2">
                {!inbound && (
                  <p className="mb-1.5 text-[10px] text-[var(--text-dim)]">
                    Intended: {e.who}
                    {e.recipientVerified === false && (
                      <span className="ml-1 text-[var(--warning)]">[unverified]</span>
                    )}
                    <br />
                    <span className="text-[var(--success)]">
                      Actually sent: {e.actuallyTo}
                    </span>
                  </p>
                )}
                <pre className="scroll-thin max-h-56 overflow-y-auto whitespace-pre-wrap rounded bg-[var(--surface-2)] p-2 font-mono text-[10px] leading-relaxed text-[var(--text-dim)]">
                  {e.body}
                </pre>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
