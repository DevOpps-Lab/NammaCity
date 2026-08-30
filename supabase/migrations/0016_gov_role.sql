-- Government role, plus the two things a city-wide analytics console needs and
-- this schema does not yet have: a trustworthy clock on state transitions, and
-- indexes that are not user_id-leading.
--
-- Numbering note: there is no 0014. It was never written; this continues from
-- 0015 rather than filling a gap that would look like a lost migration.

-- ---------------------------------------------------------------- the role
--
-- One role, city-wide, deliberately. Ward-scoped officers are a real need and a
-- different feature; inventing a scope column now would ship an access model
-- nothing enforces.
--
-- Granted by email, which is how the operator thinks about it:
--   update public.profiles set role = 'gov' where email = 'admin@gmail.com';
alter table public.profiles
  add column if not exists role text not null default 'citizen'
    check (role in ('citizen', 'gov'));

/*
  The authorisation predicate for every analytics function.

  security definer because `profiles` RLS is own-row-only, so an invoker-rights
  read here would return nothing and every caller would be denied. It reads
  exactly one boolean about the CALLER and nothing about anyone else.

  This, not the proxy, is the boundary. src/proxy.ts says so itself: it only
  asks whether a user exists, never which user, and `reports_select_community`
  already lets any signed-in browser read the whole non-seed ledger. A check
  that lives only in the page would hide the UI and guard no data.
*/
create or replace function public.civic_is_gov()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
      from public.profiles p
     where p.id = (select auth.uid())
       and p.role = 'gov'
  );
$$;

grant execute on function public.civic_is_gov() to authenticated;

-- --------------------------------------------------- a real transition clock
--
-- ADDED WITHOUT A DEFAULT, THEN GIVEN ONE. The order matters.
--
-- `add column ... timestamptz default now()` does not rewrite the table, but it
-- does make every existing row report that default, which would stamp the
-- entire recorded history of this project with the afternoon the migration ran.
-- Adding it bare leaves history NULL, which is true: those rows predate the
-- column. Only rows written from now on carry a real server timestamp.
--
-- Why it is needed at all: timeline_events.at is a client-supplied bigint
-- written through the demo clock, where DEMO_SPEEDUP = 3600. Ten seconds of
-- demo mode moves it ten simulated hours, and nothing records that demo mode
-- was on. Transition latency measured on that column is fiction.
alter table public.timeline_events
  add column if not exists inserted_at timestamptz;

alter table public.timeline_events
  alter column inserted_at set default now();

-- ------------------------------------------------------- analytics indexes
--
-- Every existing index on `reports` leads with user_id, because every existing
-- query is one citizen's ledger. A console groups across all users, so none of
-- them apply and civic_ward_scoreboard() is already a guaranteed sequential
-- scan. These are the access paths the console actually uses.
create index if not exists reports_seed_status_idx
  on public.reports (is_seed, status);

-- reports.inserted_at is the ONLY server-authoritative clock on this table, and
-- until now it was written by Postgres and read by nobody.
create index if not exists reports_inserted_at_idx
  on public.reports (inserted_at);

-- Text, not int. `routing ->> 'ward'` coerces a JSON number, and a cast in the
-- index expression would fail the day a Tier 2 resolve writes a non-numeric
-- ward. Ordering is fixed in the query instead.
create index if not exists reports_ward_idx
  on public.reports ((routing ->> 'ward'));

create index if not exists timeline_kind_idx
  on public.timeline_events (kind);
