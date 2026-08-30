-- Repairs that did not hold, as counts a scheduler can publish.
--
-- This is the finding no department's own reporting can produce. From inside a
-- municipal system, a defect fixed in March and re-reported in July is two
-- closed tickets and a success. Only a ledger that keeps the citizen's
-- verification photograph separate from the authority's claim can see that the
-- same road failed twice.
--
-- WHY A SECOND FUNCTION RATHER THAN REUSING civic_admin_recurrence.
--
-- That one is government-only and returns coordinates, because an officer
-- dispatching a crew needs to know where to send it. This returns ward-level
-- COUNTS and no coordinates at all, which is what makes it safe to grant to
-- `anon` and therefore safe to hand to a scheduler running in a third-party
-- account. Same reasoning as civic_ward_scoreboard (0015:9-19): the alternative
-- is giving n8n a service-role key that bypasses every RLS policy in the
-- project, in order to read some numbers.
--
-- Seeded rows are excluded, exactly as the scoreboard excludes them. A demo
-- caseload must never reach a published figure, and a simulated caseload of
-- 4000 rows must never reach one either.
create or replace function public.civic_repeat_digest()
returns table (
  ward            text,
  zone            text,
  category        text,
  locations       bigint,
  came_back       bigint,
  worst_repeats   bigint
)
language sql
security definer
set search_path = public
stable
as $$
  with spots as (
    select
      coalesce(r.routing ->> 'ward', 'unknown')                         as ward,
      coalesce(r.routing ->> 'zoneName', r.routing ->> 'cityName', '-') as zone,
      r.category,
      round(r.lat::numeric, 3)                                          as gy,
      round(r.lng::numeric, 3)                                          as gx,
      count(*)                                                          as n,
      -- A resident's photograph closed something here, and something here was
      -- reported again afterwards.
      bool_or(r.status = 'verified_fixed')
        and count(*) filter (where r.status <> 'verified_fixed') > 0     as returned
    from public.reports r
    where r.is_seed = false
    group by 1, 2, 3, 4, 5
    having count(*) > 1
  )
  select
    s.ward,
    s.zone,
    s.category,
    count(*)::bigint                              as locations,
    count(*) filter (where s.returned)::bigint    as came_back,
    max(s.n)::bigint                              as worst_repeats
  from spots s
  group by 1, 2, 3
  order by 5 desc, 4 desc;
$$;

-- Counts by ward and category. No coordinates, no report ids, no photo URLs,
-- nothing a citizen could be identified from.
grant execute on function public.civic_repeat_digest() to anon, authenticated;
