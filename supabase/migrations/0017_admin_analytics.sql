-- City-wide analytics for the government console at /admin.
--
-- THE RULE EVERY FUNCTION HERE FOLLOWS.
--
-- Each is `security definer`, so each bypasses RLS, and each therefore opens by
-- calling civic_is_gov() and raising if the caller is not a government account.
-- The grant is to `authenticated` because the function must be reachable; the
-- check inside is what makes it safe. A citizen calling these directly gets an
-- exception, not a smaller result set.
--
-- This follows the precedent already set twice in this schema:
-- civic_ward_scoreboard (0015:9-19) is definer-and-aggregate-only so an external
-- scheduler never needs the service-role key, and civic_sweep_owner (0010:61-64)
-- has execute revoked precisely because it takes an owner as an argument.
--
-- TIME COMES FROM inserted_at, NEVER created_at. created_at is a client-supplied
-- bigint written through a demo clock that compresses an hour into a second, and
-- no column records whether demo mode was on. reports.inserted_at is a real
-- timestamptz written by Postgres. Every time bucket below uses it.
--
-- NOTHING HERE RETURNS user_id, phone OR email. The drill-down returns the
-- report and not the reporter.

-- ------------------------------------------------------------------ funnel
--
-- Stages are counted from timeline_events, not from current status, because the
-- question is "how many ever reached acknowledged", not "how many are sitting
-- there now". A report that was acknowledged and later escalated must count in
-- both, or the funnel understates what the department actually did.
--
-- The kind vocabulary is NOT the status vocabulary. correspondence.ts maps
-- `query` onto acknowledged and `rejected` onto past_sla, so those are folded in
-- here; reading kind as a status would silently lose them.
--
-- `Claimed fixed` and `Verified fixed` are separate rows and must never be
-- summed by a caller. status.ts:11-14 states why: reporting an authority's own
-- word and a citizen's photograph as one number is the lie this product exists
-- to refuse.
create or replace function public.civic_admin_funnel(
  p_from        timestamptz default null,
  p_to          timestamptz default null,
  p_ward        text        default null,
  p_category    text        default null,
  p_include_sim boolean     default true
)
returns table (stage text, ord int, reports bigint, arm boolean)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not public.civic_is_gov() then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  return query
  with scoped as (
    select r.user_id, r.id
      from public.reports r
     where r.inserted_at >= coalesce(p_from, '-infinity'::timestamptz)
       and r.inserted_at <  coalesce(p_to,    'infinity'::timestamptz)
       and (p_ward     is null or coalesce(r.routing ->> 'ward', 'unknown') = p_ward)
       and (p_category is null or r.category = p_category)
       and (p_include_sim or r.is_seed = false)
  ),
  ev as (
    select distinct t.user_id, t.report_id, t.kind
      from public.timeline_events t
      join scoped s
        on s.user_id = t.user_id
       and s.id      = t.report_id
  ),
  stages (stage, ord, arm, kinds) as (
    values
      ('Filed'::text,          1, false, array['filed']),
      ('Acknowledged'::text,   2, false, array['acknowledged', 'query']),
      ('Claimed fixed'::text,  3, false, array['claims_done']),
      ('Verified fixed'::text, 4, false, array['verified_fixed']),
      ('Transferred'::text,    5, true,  array['transferred', 'jurisdiction_transfer']),
      ('Past SLA'::text,       6, true,  array['past_sla', 'rejected']),
      ('Escalated'::text,      7, true,  array['escalated'])
  )
  select
    st.stage,
    st.ord,
    count(distinct e.user_id::text || ':' || e.report_id)::bigint,
    st.arm
  from stages st
  left join ev e on e.kind = any (st.kinds)
  group by st.stage, st.ord, st.arm
  order by st.ord;
end;
$$;

-- ------------------------------------------------------------------- wards
--
-- Shaded by breach rate rather than volume, so a dense ward that answers its
-- complaints does not look worse than a quiet one that ignores them.
create or replace function public.civic_admin_wards(
  p_from        timestamptz default null,
  p_to          timestamptz default null,
  p_category    text        default null,
  p_include_sim boolean     default true
)
returns table (
  ward        text,
  zone        text,
  total       bigint,
  breached    bigint,
  claimed     bigint,
  verified    bigint,
  breach_rate numeric
)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not public.civic_is_gov() then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  return query
  select
    coalesce(r.routing ->> 'ward', 'unknown')                          as ward,
    coalesce(r.routing ->> 'zoneName', r.routing ->> 'cityName', '-')  as zone,
    count(*)::bigint                                                   as total,
    count(*) filter (where r.status in ('past_sla', 'escalated'))::bigint,
    count(*) filter (where r.status = 'claims_done')::bigint,
    count(*) filter (where r.status = 'verified_fixed')::bigint,
    round(
      100.0 * count(*) filter (where r.status in ('past_sla', 'escalated'))
            / nullif(count(*), 0),
      1
    )
  from public.reports r
  where r.inserted_at >= coalesce(p_from, '-infinity'::timestamptz)
    and r.inserted_at <  coalesce(p_to,    'infinity'::timestamptz)
    and (p_category is null or r.category = p_category)
    and (p_include_sim or r.is_seed = false)
  group by 1, 2
  -- Numeric wards sort numerically. `routing ->> 'ward'` coerces a JSON number
  -- to text, so a plain sort puts ward 10 before ward 2.
  order by
    case when coalesce(r.routing ->> 'ward', '') ~ '^\d+$'
         then (r.routing ->> 'ward')::int
         else 2147483647
    end,
    1;
end;
$$;

-- -------------------------------------------------------------------- when
--
-- Hour of day by day of week, in Asia/Kolkata. dow is 0 = Sunday, matching
-- Postgres, and the client labels it.
create or replace function public.civic_admin_when(
  p_from        timestamptz default null,
  p_to          timestamptz default null,
  p_ward        text        default null,
  p_category    text        default null,
  p_include_sim boolean     default true
)
returns table (dow int, hour int, n bigint)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not public.civic_is_gov() then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  return query
  select
    extract(dow  from r.inserted_at at time zone 'Asia/Kolkata')::int,
    extract(hour from r.inserted_at at time zone 'Asia/Kolkata')::int,
    count(*)::bigint
  from public.reports r
  where r.inserted_at >= coalesce(p_from, '-infinity'::timestamptz)
    and r.inserted_at <  coalesce(p_to,    'infinity'::timestamptz)
    and (p_ward     is null or coalesce(r.routing ->> 'ward', 'unknown') = p_ward)
    and (p_category is null or r.category = p_category)
    and (p_include_sim or r.is_seed = false)
  group by 1, 2
  order by 1, 2;
end;
$$;

-- ------------------------------------------------------------- departments
--
-- filed_to is a text[] of authority NAMES and one report is deliberately filed
-- to several agencies when jurisdiction is ambiguous, so these counts sum to
-- more than the number of reports. That is correct and the UI says so.
--
-- median_ack_hours is measured between reports.inserted_at and the first
-- acknowledgement event's inserted_at, both real server clocks. Rows written
-- before 0016 have a null timeline inserted_at and are excluded rather than
-- guessed at, so this can legitimately return null for a department.
create or replace function public.civic_admin_departments(
  p_from        timestamptz default null,
  p_to          timestamptz default null,
  p_ward        text        default null,
  p_include_sim boolean     default true
)
returns table (
  dept             text,
  filed            bigint,
  breached         bigint,
  claimed          bigint,
  verified         bigint,
  median_ack_hours numeric
)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not public.civic_is_gov() then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  return query
  with scoped as (
    select r.user_id, r.id, r.status, r.inserted_at, unnest(r.filed_to) as dept
      from public.reports r
     where r.inserted_at >= coalesce(p_from, '-infinity'::timestamptz)
       and r.inserted_at <  coalesce(p_to,    'infinity'::timestamptz)
       and (p_ward is null or coalesce(r.routing ->> 'ward', 'unknown') = p_ward)
       and (p_include_sim or r.is_seed = false)
  ),
  ack as (
    select t.user_id, t.report_id, min(t.inserted_at) as at
      from public.timeline_events t
     where t.kind in ('acknowledged', 'query')
       and t.inserted_at is not null
     group by 1, 2
  )
  select
    s.dept,
    count(*)::bigint,
    count(*) filter (where s.status in ('past_sla', 'escalated'))::bigint,
    count(*) filter (where s.status = 'claims_done')::bigint,
    count(*) filter (where s.status = 'verified_fixed')::bigint,
    round(
      percentile_cont(0.5) within group (
        order by extract(epoch from (a.at - s.inserted_at)) / 3600.0
      )::numeric,
      1
    )
  from scoped s
  left join ack a
    on a.user_id   = s.user_id
   and a.report_id = s.id
  group by s.dept
  order by 2 desc;
end;
$$;

-- ------------------------------------------------------------- recurrence
--
-- Defects reported repeatedly at the same spot. `returned` is the one that
-- matters to a city: an earlier report at this location was verified fixed by a
-- resident's photograph and a new one has since been filed, which means the
-- repair did not hold.
--
-- Clustered at three decimal places, roughly 100m, which is about the accuracy
-- a phone GPS gives on a street.
create or replace function public.civic_admin_recurrence(
  p_from        timestamptz default null,
  p_to          timestamptz default null,
  p_min_count   int         default 2,
  p_include_sim boolean     default true
)
returns table (
  lat       double precision,
  lng       double precision,
  place     text,
  category  text,
  n         bigint,
  returned  boolean,
  last_seen timestamptz
)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not public.civic_is_gov() then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  return query
  select
    avg(r.lat)::double precision,
    avg(r.lng)::double precision,
    (array_agg(r.place order by r.inserted_at desc))[1],
    r.category,
    count(*)::bigint,
    bool_or(r.status = 'verified_fixed')
      and count(*) filter (where r.status <> 'verified_fixed') > 0,
    max(r.inserted_at)
  from public.reports r
  where r.inserted_at >= coalesce(p_from, '-infinity'::timestamptz)
    and r.inserted_at <  coalesce(p_to,    'infinity'::timestamptz)
    and (p_include_sim or r.is_seed = false)
  group by round(r.lat::numeric, 3), round(r.lng::numeric, 3), r.category
  having count(*) >= p_min_count
  order by 5 desc, 7 desc
  limit 200;
end;
$$;

-- -------------------------------------------------------------- drill-down
--
-- The records behind a number. Returns the report and NOT the reporter: no
-- user_id, no phone, no email. The public_token is included because it is the
-- addressable, non-enumerable handle for a single report and the console needs
-- to be able to open one.
create or replace function public.civic_admin_reports(
  p_from        timestamptz default null,
  p_to          timestamptz default null,
  p_ward        text        default null,
  p_category    text        default null,
  p_status      text        default null,
  p_include_sim boolean     default true,
  p_limit       int         default 100
)
returns table (
  report_id  text,
  token      uuid,
  category   text,
  severity   text,
  status     text,
  place      text,
  ward       text,
  lat        double precision,
  lng        double precision,
  filed_at   timestamptz,
  photo_url  text,
  simulated  boolean
)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not public.civic_is_gov() then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  return query
  select
    r.id,
    r.public_token,
    r.category,
    r.severity,
    r.status,
    r.place,
    coalesce(r.routing ->> 'ward', 'unknown'),
    r.lat,
    r.lng,
    r.inserted_at,
    r.photo_url,
    r.is_seed
  from public.reports r
  where r.inserted_at >= coalesce(p_from, '-infinity'::timestamptz)
    and r.inserted_at <  coalesce(p_to,    'infinity'::timestamptz)
    and (p_ward     is null or coalesce(r.routing ->> 'ward', 'unknown') = p_ward)
    and (p_category is null or r.category = p_category)
    and (p_status   is null or r.status = p_status)
    and (p_include_sim or r.is_seed = false)
  order by r.inserted_at desc
  limit least(coalesce(p_limit, 100), 500);
end;
$$;

grant execute on function public.civic_admin_funnel(timestamptz, timestamptz, text, text, boolean)      to authenticated;
grant execute on function public.civic_admin_wards(timestamptz, timestamptz, text, boolean)             to authenticated;
grant execute on function public.civic_admin_when(timestamptz, timestamptz, text, text, boolean)        to authenticated;
grant execute on function public.civic_admin_departments(timestamptz, timestamptz, text, boolean)       to authenticated;
grant execute on function public.civic_admin_recurrence(timestamptz, timestamptz, int, boolean)         to authenticated;
grant execute on function public.civic_admin_reports(timestamptz, timestamptz, text, text, text, boolean, int) to authenticated;
