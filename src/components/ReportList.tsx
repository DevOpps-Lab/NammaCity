"use client";

import { useMemo, useState } from "react";
import type { Report } from "@/lib/types";
import { STATUS_STYLES, isOpen, isBreached } from "@/lib/status";
import { formatRemaining, now } from "@/lib/demoClock";
import Icon from "./Icon";

type Filter = "all" | "open" | "breached" | "claimed" | "closed";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "claimed", label: "Awaiting you" },
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "breached", label: "Past SLA" },
  { key: "closed", label: "Closed" },
];

interface Stats {
  open: number;
  breached: number;
  verified: number;
  fixRate: number;
  claimedRate: number;
}

/**
 * The citizen's own ledger.
 *
 * "Awaiting you" leads the filter row rather than sitting in the middle,
 * because `claims_done` is the state where the product needs something from the
 * human: an authority has said it is fixed and only a resident can confirm or
 * refute that.
 *
 * The verified / claimed pair is pinned to the top here. On a phone the top bar
 * hides it behind a breakpoint, so this is where the comparison the product
 * exists to make stays reachable at any width.
 */
export default function ReportList({
  reports,
  onSelect,
  threadCounts,
  stats,
}: {
  reports: Report[];
  onSelect: (r: Report) => void;
  /** reportId -> message count, for the correspondence hint on each row. */
  threadCounts: Record<string, number>;
  stats: Stats;
}) {
  const [filter, setFilter] = useState<Filter>("claimed");
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
      <div className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--bg)]/95 backdrop-blur">
        <div className="mx-auto w-full max-w-2xl">
          {/* verified vs claimed — the whole thesis, one figure each */}
          <div className="flex divide-x divide-[var(--border)] border-b border-[var(--border)]">
            <div className="flex-1 px-4 py-3">
              <p className="t-micro leading-none text-[var(--success)]">Citizen-verified</p>
              <p className="mt-2 flex items-baseline gap-2">
                <span className="tnum text-[26px] font-semibold leading-none text-[var(--success)]">
                  {stats.fixRate}%
                </span>
                <span className="tnum text-[12px] text-[var(--text-faint)]">
                  {stats.verified} closed
                </span>
              </p>
            </div>
            <div className="flex-1 px-4 py-3">
              <p className="t-micro leading-none">Authority-claimed</p>
              <p className="mt-2 flex items-baseline gap-2">
                <span className="tnum text-[26px] font-semibold leading-none text-[var(--text-dim)]">
                  {stats.claimedRate}%
                </span>
                <span className="t-micro leading-none">unverified</span>
              </p>
            </div>
          </div>

          <div className="flex items-baseline justify-between gap-3 px-4 pt-3.5">
            <h1 className="t-title">My reports</h1>
            <p className="t-micro">{counts.open} open</p>
          </div>

          <div className="flex gap-1.5 overflow-x-auto no-bar px-4 py-3">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                aria-pressed={filter === f.key}
                className={`shrink-0 rounded-[var(--radius-chip)] px-3 py-2 text-[12px] font-semibold transition-colors ${
                  filter === f.key
                    ? "bg-[var(--accent)] text-[var(--on-accent)]"
                    : "border border-[var(--border)] font-medium text-[var(--text-dim)] hover:border-[var(--border-strong)]"
                }`}
              >
                {f.label}
                <span className="tnum ml-1.5 opacity-70">{counts[f.key]}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mx-auto w-full max-w-2xl px-4 py-4">
        {shown.length === 0 ? (
          <p className="t-sm py-16 text-center text-[var(--text-dim)]">
            {filter === "all"
              ? "You haven't filed anything yet."
              : filter === "claimed"
                ? "Nothing is waiting on you right now."
                : "Nothing in this filter."}
          </p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {shown.map((r, i) => {
              const style = STATUS_STYLES[r.status];
              const overdue = t > r.slaDeadline;
              const closed = r.status === "verified_fixed";
              const claim = r.status === "claims_done";
              const msgs = threadCounts[r.id] ?? 0;

              const rule = claim
                ? "var(--accent)"
                : overdue && !closed
                  ? "var(--danger)"
                  : "var(--border-strong)";

              return (
                <li key={r.id}>
                  <button
                    onClick={() => onSelect(r)}
                    style={{ animationDelay: `${Math.min(i * 40, 400)}ms`, borderLeftColor: rule }}
                    className="enter w-full rounded-[var(--radius-card)] border border-[var(--border)] border-l-[3px] bg-[var(--surface)] p-3.5 text-left shadow-[var(--shadow-1)] transition-colors hover:border-[var(--border-strong)]"
                  >
                    <div className="flex items-center gap-2">
                      {claim && <Icon name="alert" size={13} className="text-[var(--accent)]" />}
                      <p
                        className="t-micro leading-none"
                        style={{ color: style.color, letterSpacing: "0.09em" }}
                      >
                        {r.id} · {style.label}
                      </p>
                    </div>

                    <p className="t-head mt-1.5">
                      {r.category.replace(/_/g, " ")} · {r.place}
                    </p>

                    {claim ? (
                      <p className="t-sm mt-1.5 text-[var(--text-dim)]">
                        Marked fixed by the authority. Nobody has checked.
                      </p>
                    ) : !closed ? (
                      <p className="mt-2 flex items-baseline gap-2">
                        <span
                          className="tnum text-[22px] font-semibold leading-none"
                          style={{ color: overdue ? "var(--danger)" : "var(--text-dim)" }}
                        >
                          {formatRemaining(r.slaDeadline, t)}
                        </span>
                        <span className="t-sm text-[var(--text-faint)]">
                          {overdue ? "past their own standard" : "left on the clock"}
                        </span>
                      </p>
                    ) : null}

                    <div className="mt-2.5 flex items-center gap-3 border-t border-[var(--border)] pt-2.5">
                      <span className="t-micro leading-none">
                        {r.supporters} {r.supporters === 1 ? "voice" : "voices"}
                      </span>
                      {msgs > 0 && (
                        <span className="t-micro leading-none text-[var(--accent)]">
                          {msgs} message{msgs === 1 ? "" : "s"}
                        </span>
                      )}
                      {claim && (
                        <span className="ml-auto text-[12px] font-bold text-[var(--accent)]">
                          Verify with a photo &rarr;
                        </span>
                      )}
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
