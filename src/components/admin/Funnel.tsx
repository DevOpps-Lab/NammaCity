"use client";

import type { FunnelRow } from "@/lib/admin-data";
import { STATUS_STYLES } from "@/lib/status";

/**
 * Stage counts are "ever reached", taken from the event log rather than from
 * current status. A report that was acknowledged in March and escalated in May
 * belongs in both rows; counting only where things sit today would credit the
 * department with neither.
 *
 * `Claimed fixed` and `Verified fixed` are drawn apart and never added. One is
 * the department's own word, the other is a photograph a resident took. The gap
 * between those two bars is the only number on this screen that cannot be
 * produced by the department that is being measured.
 */

/**
 * Only stages that map cleanly onto a single current status offer drill-down.
 * "Ever acknowledged" has no status to filter by, and inventing one would show
 * a list that does not match the bar it came from.
 */
const DRILLABLE: Record<string, string> = {
  "Claimed fixed": "claims_done",
  "Verified fixed": "verified_fixed",
  "Past SLA": "past_sla",
  Escalated: "escalated",
};

const COLOUR: Record<string, string> = {
  Filed: STATUS_STYLES.filed.color,
  Acknowledged: STATUS_STYLES.acknowledged.color,
  "Claimed fixed": STATUS_STYLES.claims_done.color,
  "Verified fixed": STATUS_STYLES.verified_fixed.color,
  Transferred: STATUS_STYLES.transferred.color,
  "Past SLA": STATUS_STYLES.past_sla.color,
  Escalated: STATUS_STYLES.escalated.color,
};

export default function Funnel({
  rows,
  loading,
  onDrill,
}: {
  rows: FunnelRow[];
  loading: boolean;
  onDrill: (status: string, label: string) => void;
}) {
  const stages = rows.filter((r) => !r.arm);
  const arms = rows.filter((r) => r.arm);
  const top = stages[0]?.reports ?? 0;

  if (loading) return <Skeleton />;
  if (!rows.length) return <Empty />;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <section className="panel p-4">
        <h2 className="t-head">Where complaints stop</h2>
        <p className="t-sm mt-1 text-[var(--text-dim)]">
          How many reports ever reached each stage, not where they sit today.
        </p>

        <ul className="mt-4 flex flex-col gap-3">
          {stages.map((s, i) => {
            const prev = stages[i - 1];
            const lost = prev ? prev.reports - s.reports : 0;
            const pct = top ? Math.round((s.reports / top) * 100) : 0;
            const status = DRILLABLE[s.stage];

            return (
              <li key={s.stage}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[13px] font-semibold">{s.stage}</span>
                  <span className="flex items-baseline gap-2">
                    <span className="tnum text-[15px] font-semibold">
                      {s.reports.toLocaleString()}
                    </span>
                    <span className="tnum text-[12px] text-[var(--text-faint)]">{pct}%</span>
                  </span>
                </div>

                <div className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-[var(--surface-2)]">
                  <div
                    className="h-full rounded-full transition-[width] duration-500"
                    style={{ width: `${pct}%`, background: COLOUR[s.stage] }}
                  />
                </div>

                <div className="mt-1 flex items-baseline justify-between gap-3">
                  <span className="text-[12px] text-[var(--text-faint)]">
                    {prev && lost > 0
                      ? `${lost.toLocaleString()} did not get this far`
                      : " "}
                  </span>
                  {status && s.reports > 0 && (
                    <button
                      onClick={() => onDrill(status, `Currently ${s.stage.toLowerCase()}`)}
                      className="text-[12px] font-semibold text-[var(--accent)] hover:underline"
                    >
                      Show reports
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        <p className="mt-4 border-t border-[var(--border)] pt-3 text-[12px] leading-relaxed text-[var(--text-faint)]">
          Claimed fixed and verified fixed are counted separately and never added together. The
          first is the department&apos;s own word; the second is a photograph a resident took of the
          repaired site.
        </p>
      </section>

      <section className="panel h-fit p-4">
        <h2 className="t-head">Leaving the funnel</h2>
        <p className="t-sm mt-1 text-[var(--text-dim)]">
          Reports that took a detour rather than progressing.
        </p>

        <ul className="mt-4 flex flex-col gap-3">
          {arms.map((a) => {
            const status = DRILLABLE[a.stage];
            return (
              <li key={a.stage} className="flex items-center gap-3">
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: COLOUR[a.stage] }}
                />
                <span className="text-[13px]">{a.stage}</span>
                <span className="tnum ml-auto text-[14px] font-semibold">
                  {a.reports.toLocaleString()}
                </span>
                {status && a.reports > 0 && (
                  <button
                    onClick={() => onDrill(status, `Currently ${a.stage.toLowerCase()}`)}
                    aria-label={`Show ${a.stage} reports`}
                    className="text-[12px] font-semibold text-[var(--accent)] hover:underline"
                  >
                    Show
                  </button>
                )}
              </li>
            );
          })}
        </ul>

        <p className="mt-4 border-t border-[var(--border)] pt-3 text-[12px] leading-relaxed text-[var(--text-faint)]">
          A transfer re-files to another agency and does not reset the clock, so a report can appear
          here and still be counted late.
        </p>
      </section>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="panel p-4">
      <div className="shimmer h-5 w-40 rounded" />
      <div className="mt-5 flex flex-col gap-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i}>
            <div className="shimmer h-3 w-24 rounded" />
            <div className="shimmer mt-2 h-2.5 w-full rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

function Empty() {
  return (
    <div className="panel p-8 text-center">
      <p className="t-body">No reports in this period.</p>
      <p className="t-sm mt-1 text-[var(--text-dim)]">
        Widen the period, or clear the category filter.
      </p>
    </div>
  );
}
