"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { CATEGORY_OPTIONS } from "@/lib/categories";
import {
  fetchDepartments,
  fetchFunnel,
  fetchRecurrence,
  fetchWards,
  fetchWhen,
  type AdminFilters,
  type DeptRow,
  type FunnelRow,
  type RecurRow,
  type WardRow,
  type WhenCell,
} from "@/lib/admin-data";
import Funnel from "./Funnel";
import WhenGrid from "./WhenGrid";
import Departments from "./Departments";
import Recurrence from "./Recurrence";
import WardMap from "./WardMap";
import DrillDown from "./DrillDown";

type View = "funnel" | "wards" | "when" | "departments" | "recurrence";

const VIEWS: { key: View; label: string }[] = [
  { key: "funnel", label: "Funnel" },
  { key: "wards", label: "Wards" },
  { key: "when", label: "When" },
  { key: "departments", label: "Departments" },
  { key: "recurrence", label: "Recurrence" },
];

const RANGES: { key: string; label: string; days: number | null }[] = [
  { key: "30d", label: "30 days", days: 30 },
  { key: "90d", label: "90 days", days: 90 },
  { key: "12m", label: "12 months", days: 365 },
  { key: "all", label: "All time", days: null },
];

/**
 * The city console.
 *
 * One filter set drives five views, because a question about a ward is the same
 * question as one about an hour: the officer is narrowing the same population.
 * Every panel therefore takes the same `AdminFilters` and every number on screen
 * is answering the same query.
 *
 * All five reads go straight from this browser to Postgres through
 * `security definer` functions that check the caller's role themselves. There is
 * no API route in the middle and no service-role key anywhere near this file.
 */
export default function AdminConsole() {
  const supabase = useMemo(() => createClient(), []);

  const [view, setView] = useState<View>("funnel");
  const [range, setRange] = useState("90d");
  const [category, setCategory] = useState<string | null>(null);
  const [ward, setWard] = useState<string | null>(null);
  const [includeSim, setIncludeSim] = useState(true);

  /** Set when a panel asks to see the records behind a number. */
  const [drill, setDrill] = useState<{ ward?: string; status?: string; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filters: AdminFilters = useMemo(
    () => ({
      rangeDays: RANGES.find((r) => r.key === range)?.days ?? null,
      ward,
      category,
      includeSim,
    }),
    [range, ward, category, includeSim]
  );

  /**
   * One payload for all five panels, stamped with the filters it answers.
   *
   * Loading is DERIVED from that stamp rather than stored, which is what keeps
   * the effect from calling setState synchronously and cascading a render on
   * every filter change. It also removes a class of bug this shape used to
   * invite: a slow response for the previous filters can no longer land on top
   * of the current ones, because the key would not match.
   */
  const key = JSON.stringify(filters);
  const [payload, setPayload] = useState<{
    key: string;
    funnel: FunnelRow[];
    wards: WardRow[];
    when: WhenCell[];
    depts: DeptRow[];
    recur: RecurRow[];
  } | null>(null);

  const loading = payload?.key !== key;

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [funnel, wards, when, depts, recur] = await Promise.all([
          fetchFunnel(supabase, filters),
          fetchWards(supabase, filters),
          fetchWhen(supabase, filters),
          fetchDepartments(supabase, filters),
          fetchRecurrence(supabase, filters),
        ]);
        if (!alive) return;
        setError(null);
        setPayload({ key, funnel, wards, when, depts, recur });
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "Could not load city data.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [supabase, filters, key]);

  const funnel = payload?.funnel ?? [];
  const wards = payload?.wards ?? [];
  const when = payload?.when ?? [];
  const depts = payload?.depts ?? [];
  const recur = payload?.recur ?? [];

  const totalReports = funnel.find((s) => s.ord === 1)?.reports ?? 0;
  const simulated = includeSim;

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--border)] px-4 sm:px-6">
        <div className="min-w-0">
          <h1 className="t-head truncate">City console</h1>
        </div>

        {/*
          Permanent, not dismissible. A city figure that silently contains
          generated rows is worse than no figure, so the state is on screen
          whenever it is true rather than buried in a settings panel.
        */}
        {simulated && (
          <span
            className="chip-status shrink-0"
            style={{
              color: "var(--warning)",
              borderColor: "color-mix(in srgb, var(--warning) 45%, transparent)",
              background: "color-mix(in srgb, var(--warning) 12%, transparent)",
            }}
          >
            Includes simulated data
          </span>
        )}

        <span className="tnum ml-auto shrink-0 text-[12px] text-[var(--text-faint)]">
          {loading ? "loading" : `${totalReports.toLocaleString()} reports`}
        </span>
      </header>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-4 py-4 sm:px-6">
          {/* ---------------------------------------------------- filters */}
          <div className="panel flex flex-wrap items-end gap-x-5 gap-y-3 p-3.5">
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-[var(--text-dim)]">
                Period
              </span>
              <div className="seg">
                {RANGES.map((r) => (
                  <button
                    key={r.key}
                    onClick={() => setRange(r.key)}
                    aria-pressed={range === r.key}
                    className="text-[12px]"
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-[var(--text-dim)]">
                Category
              </span>
              <select
                value={category ?? ""}
                onChange={(e) => setCategory(e.target.value || null)}
                className="field h-[38px] min-h-0 w-44 py-0 text-[13px]"
              >
                <option value="">All categories</option>
                {CATEGORY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>

            {ward && (
              <button
                onClick={() => setWard(null)}
                className="btn btn-outline h-[38px] min-h-0 text-[12px]"
              >
                Ward {ward} &times;
              </button>
            )}

            <label className="ml-auto flex items-center gap-2.5">
              <input
                type="checkbox"
                checked={includeSim}
                onChange={(e) => setIncludeSim(e.target.checked)}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              <span className="text-[12px] leading-snug">
                <span className="font-medium">Include simulated data</span>
                <span className="mt-0.5 block text-[var(--text-faint)]">
                  Untick to count only reports residents actually filed.
                </span>
              </span>
            </label>
          </div>

          {/* ------------------------------------------------ view switch */}
          <div className="mt-4 flex gap-1.5 overflow-x-auto no-bar">
            {VIEWS.map((v) => (
              <button
                key={v.key}
                onClick={() => setView(v.key)}
                aria-pressed={view === v.key}
                className={`shrink-0 rounded-[var(--radius-chip)] px-3 py-1.5 text-[12px] transition-colors ${
                  view === v.key
                    ? "bg-[var(--accent)] font-semibold text-[var(--on-accent)]"
                    : "border border-[var(--border)] font-medium text-[var(--text-dim)] hover:border-[var(--border-strong)]"
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>

          {error && (
            <p className="mt-4 rounded-[var(--radius-card)] border border-[var(--danger)]/35 bg-[var(--danger)]/10 px-4 py-3 text-[13px] leading-relaxed text-[var(--danger)]">
              {error}
            </p>
          )}

          <div className="mt-4 pb-8">
            {view === "funnel" && (
              <Funnel
                rows={funnel}
                loading={loading}
                onDrill={(status, label) => setDrill({ status, label })}
              />
            )}
            {view === "wards" && (
              <WardMap
                rows={wards}
                loading={loading}
                selected={ward}
                onSelect={(w) => setWard(w)}
                onDrill={(w) => setDrill({ ward: w, label: `Ward ${w}` })}
              />
            )}
            {view === "when" && <WhenGrid cells={when} loading={loading} />}
            {view === "departments" && <Departments rows={depts} loading={loading} />}
            {view === "recurrence" && <Recurrence rows={recur} loading={loading} />}
          </div>
        </div>
      </div>

      {drill && (
        <DrillDown
          filters={filters}
          ward={drill.ward}
          status={drill.status}
          label={drill.label}
          onClose={() => setDrill(null)}
        />
      )}
    </>
  );
}
