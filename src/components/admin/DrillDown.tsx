"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { fetchReports, type AdminFilters, type AdminReport } from "@/lib/admin-data";
import { STATUS_STYLES } from "@/lib/status";
import { categoryLabel } from "@/lib/categories";
import type { IssueCategory, ReportStatus } from "@/lib/types";
import Icon from "../Icon";

/**
 * The records behind a number.
 *
 * A dashboard that cannot answer "show me those" is a poster. This is the half
 * that makes the aggregates checkable.
 *
 * IT RETURNS THE REPORT AND NOT THE REPORTER. civic_admin_reports selects no
 * user_id, no phone and no email, so there is nothing to redact here because
 * nothing identifying was ever sent. A city officer needs to know a pothole was
 * reported at a junction three times; they do not need to know who reported it.
 */
export default function DrillDown({
  filters,
  ward,
  status,
  label,
  onClose,
}: {
  filters: AdminFilters;
  ward?: string;
  status?: string;
  label: string;
  onClose: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<AdminReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // No setLoading(true) here: the initial state is already true and this sheet
    // is mounted fresh per drill-down, so setting it synchronously inside the
    // effect would only add a cascading render.
    fetchReports(supabase, filters, { ward: ward ?? null, status: status ?? null, limit: 200 })
      .then((r) => alive && setRows(r))
      .catch((e) => alive && setError(e instanceof Error ? e.message : "Could not load reports."))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [supabase, filters, ward, status]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fade-in fixed inset-0 z-[var(--z-modal)] flex items-end justify-center bg-[var(--scrim)] backdrop-blur-sm md:items-center md:p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
        className="sheet-in flex max-h-[88%] w-full max-w-3xl flex-col rounded-t-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-3)] md:rounded-[var(--radius-card)]"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-[var(--border)] px-4 py-3.5">
          <div className="min-w-0">
            <h2 className="t-head truncate">{label}</h2>
            <p className="mt-0.5 text-[12px] text-[var(--text-faint)]">
              {loading ? "loading" : `${rows.length} report${rows.length === 1 ? "" : "s"}`}
              {rows.length === 200 && ", showing the most recent"}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="ml-auto grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-control)] text-[var(--text-dim)] hover:bg-[var(--hover-overlay)] hover:text-[var(--text)]"
          >
            <Icon name="close" size={18} />
          </button>
        </header>

        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">
          {error && (
            <p className="rounded-[var(--radius-control)] border border-[var(--danger)]/35 bg-[var(--danger)]/10 px-3 py-2 text-[13px] text-[var(--danger)]">
              {error}
            </p>
          )}

          {loading && <div className="shimmer h-40 w-full rounded" />}

          {!loading && !error && rows.length === 0 && (
            <p className="t-sm py-10 text-center text-[var(--text-dim)]">
              Nothing matches this selection.
            </p>
          )}

          <ul className="flex flex-col gap-2">
            {rows.map((r) => {
              const style = STATUS_STYLES[r.status as ReportStatus];
              return (
                <li
                  key={`${r.report_id}-${r.token}`}
                  className="flex items-start gap-3 rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-2)] p-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-semibold">
                        {categoryLabel(r.category as IssueCategory)}
                      </span>
                      {r.simulated && (
                        <span className="shrink-0 text-[11px] text-[var(--warning)]">simulated</span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-[12px] text-[var(--text-dim)]">{r.place}</p>
                    <p className="mt-1 text-[11px] text-[var(--text-faint)]">
                      <span className="tnum">{r.report_id}</span>
                      {" · "}
                      <span className="tnum">
                        {new Date(r.filed_at).toLocaleDateString("en-IN", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                      </span>
                      {r.ward !== "unknown" && <> · ward {r.ward}</>}
                    </p>
                  </div>

                  {style && (
                    <span
                      className="chip-status shrink-0"
                      style={{
                        color: style.color,
                        borderColor: `color-mix(in srgb, ${style.color} 45%, transparent)`,
                        background: `color-mix(in srgb, ${style.color} 12%, transparent)`,
                      }}
                    >
                      {style.short ?? style.label}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        <p className="shrink-0 border-t border-[var(--border)] px-4 py-3 text-[12px] leading-relaxed text-[var(--text-faint)]">
          Reports are shown without the resident who filed them. No name, phone number or email
          address is returned by this view.
        </p>
      </div>
    </div>
  );
}
