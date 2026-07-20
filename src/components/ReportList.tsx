"use client";

import { useMemo, useState } from "react";
import type { Report } from "@/lib/types";
import { STATUS_STYLES, isOpen, isBreached } from "@/lib/status";
import { formatRemaining, slaProgress, now } from "@/lib/demoClock";
import Icon from "./Icon";

type Filter = "all" | "open" | "breached" | "claimed" | "closed";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "breached", label: "Past SLA" },
  { key: "claimed", label: "Awaiting you" },
  { key: "closed", label: "Closed" },
];

/**
 * The citizen's own ledger.
 *
 * "Awaiting you" is a first-class filter rather than a detail, because
 * `claims_done` is the state where the product needs something from the human:
 * an authority has said it is fixed and only a resident can confirm or refute
 * that. Burying it in "All" would let the one action that closes the loop go
 * unnoticed.
 */
export default function ReportList({
  reports,
  onSelect,
  threadCounts,
}: {
  reports: Report[];
  onSelect: (r: Report) => void;
  /** reportId -> message count, for the correspondence hint on each row. */
  threadCounts: Record<string, number>;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const t = now();

  const counts = useMemo(
    () => ({
      all: reports.length,
      open: reports.filter((r) => isOpen(r.status)).length,
      breached: reports.filter((r) => isBreached(r.status)).length,
      claimed: reports.filter((r) => r.status === "claims_done").length,
      closed: reports.filter((r) => r.status === "verified_fixed").length,
    }),
    [reports]
  );

  const shown = useMemo(() => {
    const list = reports.filter((r) => {
      switch (filter) {
        case "open":
          return isOpen(r.status);
        case "breached":
          return isBreached(r.status);
        case "claimed":
          return r.status === "claims_done";
        case "closed":
          return r.status === "verified_fixed";
        default:
          return true;
      }
    });
    return [...list].sort((a, b) => b.createdAt - a.createdAt);
  }, [reports, filter]);

  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--bg)]/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex w-full max-w-2xl gap-1.5 overflow-x-auto no-bar">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`shrink-0 rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors ${
                filter === f.key
                  ? "bg-[var(--accent)] text-[var(--on-accent)]"
                  : "border border-[var(--border)] text-[var(--text-dim)] hover:border-[var(--border-strong)]"
              }`}
            >
              {f.label}
              <span className="ml-1.5 tabular-nums opacity-70">{counts[f.key]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="mx-auto w-full max-w-2xl px-4 py-4">
        {shown.length === 0 ? (
          <p className="py-16 text-center text-[13px] text-[var(--text-dim)]">
            {filter === "all"
              ? "You haven't filed anything yet."
              : "Nothing in this filter."}
          </p>
        ) : (
          <ul className="space-y-2">
            {shown.map((r, i) => {
              const style = STATUS_STYLES[r.status];
              const progress = Math.min(slaProgress(r.createdAt, r.slaDeadline, t), 1);
              const overdue = t > r.slaDeadline;
              const closed = r.status === "verified_fixed";
              const msgs = threadCounts[r.id] ?? 0;

              return (
                <li key={r.id}>
                  <button
                    onClick={() => onSelect(r)}
                    style={{ animationDelay: `${Math.min(i * 40, 400)}ms` }}
                    className="rise-in lift w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-left"
                  >
                    <div className="flex items-start gap-3">
                      <span
                        className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{
                          background: style.hollow ? "transparent" : style.color,
                          border: `2px ${style.hollow ? "dashed" : "solid"} ${style.color}`,
                        }}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <p className="truncate text-[14px] font-semibold">{r.place}</p>
                          <span className="shrink-0 font-mono text-[10px] text-[var(--text-faint)]">
                            {r.id}
                          </span>
                        </div>

                        {/* The label is never abbreviated — "Claimed fixed —
                            unverified" is the distinction, not decoration. */}
                        <p
                          className="mt-0.5 text-[11px] font-medium"
                          style={{ color: style.color }}
                        >
                          {style.label}
                        </p>

                        <p className="mt-0.5 truncate text-[11px] text-[var(--text-dim)]">
                          {r.category.replace(/_/g, " ")} · {r.severity} ·{" "}
                          {r.supporters} {r.supporters === 1 ? "voice" : "voices"}
                          {msgs > 0 && (
                            <>
                              {" · "}
                              <span className="text-[var(--accent)]">
                                {msgs} message{msgs === 1 ? "" : "s"}
                              </span>
                            </>
                          )}
                        </p>

                        {!closed && (
                          <div className="mt-2 flex items-center gap-2">
                            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--surface-3)]">
                              <div
                                className="h-full rounded-full transition-[width] duration-500"
                                style={{
                                  width: `${Math.max(progress * 100, 2)}%`,
                                  background: overdue
                                    ? "var(--danger)"
                                    : progress > 0.75
                                      ? "var(--warning)"
                                      : "var(--success)",
                                }}
                              />
                            </div>
                            <span
                              className={`shrink-0 text-[10px] font-medium tabular-nums ${
                                overdue ? "text-[var(--danger)]" : "text-[var(--text-dim)]"
                              }`}
                            >
                              {formatRemaining(r.slaDeadline, t)}
                            </span>
                          </div>
                        )}

                        {r.status === "claims_done" && (
                          <p className="mt-2 flex items-center gap-1.5 rounded-lg bg-[var(--warning)]/12 px-2 py-1.5 text-[11px] font-medium text-[var(--warning)]">
                            <Icon name="alert" size={13} />
                            Needs your confirmation before it can close
                          </p>
                        )}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
