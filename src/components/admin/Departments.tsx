"use client";

import type { DeptRow } from "@/lib/admin-data";
import { CHENNAI_AUTHORITIES } from "@/lib/authorities";

/**
 * Per-department performance.
 *
 * Two honesty constraints, both load-bearing.
 *
 * One report is filed to several agencies whenever jurisdiction is ambiguous,
 * which is deliberate: the storm-water and sewer split fails constantly in
 * practice, so we file wide rather than guess. These rows therefore sum to more
 * than the number of reports, and the note under the table says so instead of
 * letting a reader assume otherwise.
 *
 * The SLA a department is measured against is its OWN published one, and only
 * one of the six entries in the registry was confirmed from a primary source.
 * Every row carries that provenance, because a compliance table that hides it
 * launders a placeholder into an official-looking number.
 */
export default function Departments({ rows, loading }: { rows: DeptRow[]; loading: boolean }) {
  if (loading) {
    return (
      <div className="panel p-4">
        <div className="shimmer h-5 w-44 rounded" />
        <div className="shimmer mt-5 h-32 w-full rounded" />
      </div>
    );
  }

  if (!rows.length) {
    return (
      <div className="panel p-8 text-center">
        <p className="t-body">No reports were filed to any department in this period.</p>
      </div>
    );
  }

  return (
    <section className="panel p-4">
      <h2 className="t-head">Departments</h2>
      <p className="t-sm mt-1 text-[var(--text-dim)]">
        Measured against each department&apos;s own published service standard.
      </p>

      <div className="mt-4 overflow-x-auto scroll-thin">
        <table className="w-full min-w-[640px] border-collapse text-left">
          <thead>
            <tr className="border-b border-[var(--border)] text-[12px] text-[var(--text-faint)]">
              <th className="pb-2 pr-3 font-medium">Department</th>
              <th className="pb-2 pr-3 text-right font-medium">Filed</th>
              <th className="pb-2 pr-3 text-right font-medium">Late</th>
              <th className="pb-2 pr-3 text-right font-medium">Claimed</th>
              <th className="pb-2 pr-3 text-right font-medium">Verified</th>
              <th className="pb-2 text-right font-medium">Median reply</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const reg = CHENNAI_AUTHORITIES.find((a) => a.name === r.dept);
              const lateRate = r.filed ? Math.round((r.breached / r.filed) * 100) : 0;

              return (
                <tr key={r.dept} className="border-b border-[var(--border)] last:border-0">
                  <td className="py-2.5 pr-3">
                    <span className="block text-[13px] font-medium">{r.dept}</span>
                    <span className="mt-0.5 block text-[12px] text-[var(--text-faint)]">
                      {reg
                        ? `${reg.slaHours}h standard · ${reg.verified ? "address confirmed" : "address unverified"}`
                        : "Not in the registry"}
                    </span>
                  </td>
                  <td className="tnum py-2.5 pr-3 text-right text-[13px]">{r.filed}</td>
                  <td className="tnum py-2.5 pr-3 text-right text-[13px]">
                    <span style={{ color: lateRate > 0 ? "var(--danger)" : undefined }}>
                      {r.breached}
                    </span>
                    <span className="ml-1.5 text-[11px] text-[var(--text-faint)]">
                      {lateRate}%
                    </span>
                  </td>
                  <td
                    className="tnum py-2.5 pr-3 text-right text-[13px]"
                    style={{ color: "var(--text-dim)" }}
                  >
                    {r.claimed}
                  </td>
                  <td
                    className="tnum py-2.5 pr-3 text-right text-[13px] font-semibold"
                    style={{ color: "var(--success)" }}
                  >
                    {r.verified}
                  </td>
                  <td className="tnum py-2.5 text-right text-[13px] text-[var(--text-dim)]">
                    {r.median_ack_hours == null ? "not measured" : `${r.median_ack_hours}h`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 space-y-1.5 border-t border-[var(--border)] pt-3">
        <p className="text-[12px] leading-relaxed text-[var(--text-faint)]">
          A report with ambiguous jurisdiction is filed to every plausible agency rather than
          guessing one, so these rows add up to more than the number of reports.
        </p>
        <p className="text-[12px] leading-relaxed text-[var(--text-faint)]">
          Median reply is the time to a department&apos;s first acknowledgement, measured on the
          server clock. Reports that predate that measurement show as not measured rather than as
          zero.
        </p>
      </div>
    </section>
  );
}
