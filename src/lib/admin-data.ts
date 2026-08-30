"use client";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Typed wrappers over the civic_admin_* functions.
 *
 * These are called from the browser with the ordinary authenticated client, not
 * through an API route and not with the service-role key. That is the whole
 * point of the functions being `security definer` with a civic_is_gov() check
 * inside: authorisation lives in Postgres, so there is no handler in between
 * that could get it wrong, and no bypass credential to leak.
 *
 * A citizen calling any of these gets a raised exception, which surfaces here as
 * a Supabase error rather than an empty table.
 */

export interface AdminFilters {
  /**
   * How far back to look, in days. Null means all time.
   *
   * A duration rather than a timestamp on purpose: resolving it to an instant
   * needs Date.now(), and doing that while rendering makes the component impure
   * and its output depend on when React happened to run it. The conversion
   * happens in `base()` below, which only ever runs inside an async call.
   */
  rangeDays: number | null;
  ward: string | null;
  category: string | null;
  /**
   * Whether simulated rows are counted. On by default, and the UI says so
   * permanently: a city number that quietly includes generated data is worse
   * than no number.
   */
  includeSim: boolean;
}

export interface FunnelRow {
  stage: string;
  ord: number;
  reports: number;
  /** A leakage arm off the funnel rather than a stage along it. */
  arm: boolean;
}

export interface WardRow {
  ward: string;
  zone: string;
  total: number;
  breached: number;
  claimed: number;
  verified: number;
  breach_rate: number | null;
}

export interface WhenCell {
  /** 0 = Sunday, matching Postgres. */
  dow: number;
  hour: number;
  n: number;
}

export interface DeptRow {
  dept: string;
  filed: number;
  breached: number;
  claimed: number;
  verified: number;
  /** Null where no acknowledgement carries a real server timestamp yet. */
  median_ack_hours: number | null;
}

export interface RecurRow {
  lat: number;
  lng: number;
  place: string;
  category: string;
  n: number;
  /** An earlier report here was verified fixed, and another has been filed since. */
  returned: boolean;
  last_seen: string;
}

export interface AdminReport {
  report_id: string;
  token: string;
  category: string;
  severity: string;
  status: string;
  place: string;
  ward: string;
  lat: number;
  lng: number;
  filed_at: string;
  photo_url: string;
  simulated: boolean;
}

function base(f: AdminFilters) {
  return {
    p_from: f.rangeDays ? new Date(Date.now() - f.rangeDays * 86_400_000).toISOString() : null,
    p_to: null,
    p_include_sim: f.includeSim,
  };
}

async function call<T>(
  db: SupabaseClient,
  fn: string,
  args: Record<string, unknown>
): Promise<T[]> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(error.message);
  return (data ?? []) as T[];
}

export function fetchFunnel(db: SupabaseClient, f: AdminFilters) {
  return call<FunnelRow>(db, "civic_admin_funnel", {
    ...base(f),
    p_ward: f.ward,
    p_category: f.category,
  });
}

export function fetchWards(db: SupabaseClient, f: AdminFilters) {
  return call<WardRow>(db, "civic_admin_wards", {
    ...base(f),
    p_category: f.category,
  });
}

export function fetchWhen(db: SupabaseClient, f: AdminFilters) {
  return call<WhenCell>(db, "civic_admin_when", {
    ...base(f),
    p_ward: f.ward,
    p_category: f.category,
  });
}

export function fetchDepartments(db: SupabaseClient, f: AdminFilters) {
  return call<DeptRow>(db, "civic_admin_departments", {
    ...base(f),
    p_ward: f.ward,
  });
}

export function fetchRecurrence(db: SupabaseClient, f: AdminFilters) {
  return call<RecurRow>(db, "civic_admin_recurrence", {
    ...base(f),
    p_min_count: 2,
  });
}

export function fetchReports(
  db: SupabaseClient,
  f: AdminFilters,
  extra: { ward?: string | null; status?: string | null; limit?: number } = {}
) {
  return call<AdminReport>(db, "civic_admin_reports", {
    ...base(f),
    p_ward: extra.ward ?? f.ward,
    p_category: f.category,
    p_status: extra.status ?? null,
    p_limit: extra.limit ?? 100,
  });
}
