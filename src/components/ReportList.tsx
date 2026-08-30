"use client";

import { useMemo, useState } from "react";
import type { Report } from "@/lib/types";
import { STATUS_STYLES, isOpen, isBreached } from "@/lib/status";
import { categoryLabel } from "@/lib/categories";
import { formatAge, formatRemaining, now } from "@/lib/demoClock";
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
    <div className="scroll-thin pb-navbar h-full overflow-y-auto">
      {/*
        Only the title and the filters are pinned.

        All three blocks used to be sticky, which cost about 150px of permanently
        occupied height on a 390px phone: with the top bar above it, a third of
        the screen was chrome before the first report card. The figures are a
        headline, read once on arrival. The filters are a control, needed
        whenever the list is being read, so those are what stay.
      */}
      <div className="border-b border-[var(--border)]">
        <div className="mx-auto w-full max-w-2xl">
          {/*
            Verified against claimed, the whole thesis, one figure each.

            These two labels are the only small-caps labels left on this screen.
            There were six: both of these, the open count, and one on every card
            for the id, the status and the vote tally. Uppercase mono is how you
            mark the one thing that matters, and when everything wears it, it
            marks nothing and the screen reads as generated.
          */}
          <div className="flex divide-x divide-[var(--border)]">
            <div className="flex-1 px-4 py-3.5">
              <p className="text-[12px] font-medium leading-none text-[var(--success)]">
                Citizen-verified
              </p>
              <p className="mt-2 flex items-baseline gap-2">
                <span className="tnum text-[26px] font-semibold leading-none text-[var(--success)]">
                  {stats.fixRate}%
                </span>
                <span className="text-[12px] text-[var(--text-faint)]">
                  {stats.verified} closed
                </span>
              </p>
            </div>
            <div className="flex-1 px-4 py-3.5">
              <p className="text-[12px] font-medium leading-none text-[var(--text-dim)]">
                Authority-claimed
              </p>
              <p className="mt-2 flex items-baseline gap-2">
                <span className="tnum text-[26px] font-semibold leading-none text-[var(--text-dim)]">
                  {stats.claimedRate}%
                </span>
                <span className="text-[12px] text-[var(--text-faint)]">unverified</span>
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--bg)]/95 backdrop-blur">
        <div className="mx-auto w-full max-w-2xl">
          <div className="flex items-baseline justify-between gap-3 px-4 pt-3.5">
            <h1 className="t-title">My reports</h1>
            <p className="text-[12px] text-[var(--text-faint)]">{counts.open} open</p>
          </div>

          {/*
            Five filters do not fit 390px at any sane chip size, so the rail
            scrolls. What was wrong was not the scrolling but that it was
            invisible: `no-bar` hides the scrollbar, so "Past SLA" was simply
            sliced down the middle at the screen edge and looked like a
            rendering fault. The mask fades the last few pixels instead, which
            reads as "there is more this way", and snapping makes the flick land
            on a chip rather than halfway through one.
          */}
          <div
            className="flex snap-x snap-mandatory gap-1.5 overflow-x-auto no-bar px-4 py-3 [mask-image:linear-gradient(to_right,#000_calc(100%-32px),transparent)] sm:[mask-image:none]"
          >
            {FILTERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                aria-pressed={filter === f.key}
                className={`shrink-0 snap-start rounded-[var(--radius-chip)] px-2.5 py-1.5 text-[12px] transition-colors ${
                  filter === f.key
                    ? "bg-[var(--accent)] font-semibold text-[var(--on-accent)]"
                    : "border border-[var(--border)] font-medium text-[var(--text-dim)] hover:border-[var(--border-strong)]"
                }`}
              >
                {f.label}
                {counts[f.key] > 0 && (
                  <span className="tnum ml-1.5 opacity-70">{counts[f.key]}</span>
                )}
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
                    {/* The defect leads. It is what the row is about, and it
                        used to sit on line two behind an id and a status code. */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="t-head truncate">{categoryLabel(r.category)}</p>
                        <p className="mt-0.5 truncate text-[13px] text-[var(--text-dim)]">
                          {r.place}
                        </p>
                      </div>
                      <span
                        className="chip-status shrink-0"
                        style={{
                          color: style.color,
                          borderColor: `color-mix(in srgb, ${style.color} 45%, transparent)`,
                          background: `color-mix(in srgb, ${style.color} 12%, transparent)`,
                        }}
                      >
                        {claim && <Icon name="alert" size={11} />}
                        {style.short ?? style.label}
                      </span>
                    </div>

                    {claim ? (
                      <p className="t-sm mt-2.5 text-[var(--text-dim)]">
                        Nobody has checked this. Only you can confirm it.
                      </p>
                    ) : !closed ? (
                      <p className="mt-2.5 flex items-baseline gap-2">
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

                    {/* Metadata, in the order it is actually wanted, and only
                        when it exists. "0 voices" on every row was noise, and
                        without an age two reports of the same defect on the
                        same street were impossible to tell apart. */}
                    <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-[var(--text-faint)]">
                      <span className="tnum">{r.id}</span>
                      <span aria-hidden>·</span>
                      <span>{formatAge(r.createdAt, t)}</span>
                      {r.supporters > 0 && (
                        <>
                          <span aria-hidden>·</span>
                          <span>
                            {r.supporters} {r.supporters === 1 ? "voice" : "voices"}
                          </span>
                        </>
                      )}
                      {msgs > 0 && (
                        <>
                          <span aria-hidden>·</span>
                          <span className="text-[var(--text-dim)]">
                            {msgs} repl{msgs === 1 ? "y" : "ies"}
                          </span>
                        </>
                      )}
                      {claim && (
                        <span className="ml-auto font-semibold text-[var(--accent)]">
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
