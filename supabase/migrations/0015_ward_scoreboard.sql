-- Ward-level accountability aggregate, for scheduled publication.
--
-- The product's whole argument is one comparison: how many complaints a
-- department CLAIMS to have fixed, against how many a resident actually
-- verified with a photograph. Per report that comparison is a status; per ward
-- it is a scoreboard, and the scoreboard is the thing a councillor or a
-- journalist can act on.
--
-- WHY A FUNCTION RATHER THAN A VIEW OVER `reports`.
--
-- An external scheduler (n8n) needs to read this on a timer. Handing that
-- scheduler the service-role key would give a third-party account a credential
-- that bypasses every RLS policy in the project and can write every table, in
-- order to read some counts.
--
-- This returns COUNTS ONLY — no report ids, no photo URLs, no coordinates, no
-- phone numbers, nothing that identifies a citizen. That is precisely what
-- makes it safe to grant to `anon`, whose key already ships in the client
-- bundle. The scheduler then holds nothing it did not already have.
--
-- Seeded rows are excluded: a demo caseload must never inflate a public number.
create or replace function public.civic_ward_scoreboard()
returns table (
  ward              text,
  zone              text,
  filed             bigint,
  past_sla          bigint,
  escalated         bigint,
  claims_done       bigint,
  verified_fixed    bigint,
  median_days_open  numeric
)
language sql
security definer
set search_path = public
stable
as $$
  select
    coalesce(r.routing ->> 'ward', 'unknown')                         as ward,
    coalesce(r.routing ->> 'zoneName', r.routing ->> 'cityName', '—') as zone,
    count(*)                                                          as filed,
    count(*) filter (where r.status = 'past_sla')                     as past_sla,
    count(*) filter (where r.status = 'escalated')                    as escalated,
    -- The load-bearing pair. `claims_done` is the authority's word;
    -- `verified_fixed` is a photograph that passed a check. Reporting them as
    -- one number is the lie this product exists to refuse.
    count(*) filter (where r.status = 'claims_done')                  as claims_done,
    count(*) filter (where r.status = 'verified_fixed')               as verified_fixed,
    round(
      percentile_cont(0.5) within group (
        order by (extract(epoch from now()) * 1000 - r.created_at) / 86400000.0
      )::numeric, 1
    )                                                                 as median_days_open
  from public.reports r
  where r.is_seed = false
  group by 1, 2
  order by filed desc;
$$;

-- Safe to expose: aggregates only, and never a row a citizen could be
-- identified from. Granted to authenticated as well so the app could render the
-- same scoreboard without a second implementation.
grant execute on function public.civic_ward_scoreboard() to anon, authenticated;
