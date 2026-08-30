"use client";

import type { RecurRow } from "@/lib/admin-data";
import { categoryLabel } from "@/lib/categories";
import type { IssueCategory } from "@/lib/types";

/**
 * Places that keep failing.
 *
 * `returned` is the row worth a city's attention: a resident photographed this
 * spot as repaired, the case closed on that evidence, and another report has
 * been filed at the same place since. That is a repair that did not hold, and it
 * is the one finding here that no department's own reporting would surface,
 * because from the inside both tickets look like successes.
 *
 * Clustered to roughly 100m, which is about what a phone GPS resolves on a
 * street, so two reports of the same pothole from opposite kerbs group together.
 */
export default function Recurrence({ rows, loading }: { rows: RecurRow[]; loading: boolean }) {
  if (loading) {
    return (
      <div className="panel p-4">
        <div className="shimmer h-5 w-52 rounded" />
        <div className="shimmer mt-5 h-32 w-full rounded" />
      </div>
    );
  }

  if (!rows.length) {
    return (
      <div className="panel p-8 text-center">
        <p className="t-body">No location was reported more than once in this period.</p>
        <p className="t-sm mt-1 text-[var(--text-dim)]">
          Widen the period to see whether defects are returning.
        </p>
      </div>
    );
  }

  const returned = rows.filter((r) => r.returned);

  return (
    <section className="panel p-4">
      <h2 className="t-head">Repeat locations</h2>
      <p className="t-sm mt-1 text-[var(--text-dim)]">
        {returned.length > 0 ? (
          <>
            <span className="tnum font-semibold text-[var(--danger)]">{returned.length}</span> of
            these were verified as repaired and then reported again.
          </>
        ) : (
          <>Nothing here was repaired and then reported again.</>
        )}
      </p>

      <ul className="mt-4 flex flex-col gap-2">
        {rows.map((r) => (
          <li
            key={`${r.lat},${r.lng},${r.category}`}
            className="flex items-start gap-3 rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-2)] p-3"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold">
                {categoryLabel(r.category as IssueCategory)}
              </p>
              <p className="mt-0.5 truncate text-[12px] text-[var(--text-dim)]">{r.place}</p>
              <p className="tnum mt-1 text-[11px] text-[var(--text-faint)]">
                {r.lat.toFixed(4)}, {r.lng.toFixed(4)}
              </p>
            </div>

            {r.returned && (
              <span
                className="chip-status shrink-0"
                style={{
                  color: "var(--danger)",
                  borderColor: "color-mix(in srgb, var(--danger) 45%, transparent)",
                  background: "color-mix(in srgb, var(--danger) 12%, transparent)",
                }}
              >
                Came back
              </span>
            )}

            <span className="shrink-0 text-right">
              <span className="tnum block text-[16px] font-semibold leading-none">{r.n}</span>
              <span className="mt-1 block text-[11px] text-[var(--text-faint)]">reports</span>
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-4 border-t border-[var(--border)] pt-3 text-[12px] leading-relaxed text-[var(--text-faint)]">
        Came back means a resident&apos;s photograph closed an earlier report at this spot and a new
        one has been filed since. From inside a department both of those are closed tickets.
      </p>
    </section>
  );
}
