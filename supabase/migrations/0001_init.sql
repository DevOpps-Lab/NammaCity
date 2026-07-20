-- CivicAgent — initial schema
--
-- Design notes that matter:
--
-- 1. Timestamps for report lifecycle are `bigint` epoch-ms, NOT timestamptz.
--    The app ships a demo clock that compresses 1h into 1s, so "now" is a
--    client-controlled quantity. Storing ms and passing `p_now` into the sweep
--    keeps the database authoritative about STATE without pretending to be
--    authoritative about TIME.
--
-- 2. The ledger is owner-scoped. Only the citizen who filed a report can move
--    it, which is the product's core refusal expressed as an RLS policy rather
--    than a comment. Seed reports are inserted per-account so a fresh login has
--    a populated map it is actually allowed to act on.
--
-- 3. `supporters` is a denormalised counter maintained by trigger from
--    report_supports, so one account cannot inflate a count by tapping twice.

-- ---------------------------------------------------------------- extensions
create extension if not exists pgcrypto;

-- ----------------------------------------------------------------- profiles
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  email       text,
  lang        text not null default 'en' check (lang in ('en', 'ta')),
  created_at  timestamptz not null default now()
);

comment on table public.profiles is 'One row per auth user; created by trigger on signup.';

-- Human-readable report ids (CA-4601, ...). A sequence rather than a client
-- counter, because two browsers would otherwise mint the same id.
create sequence if not exists public.report_id_seq start 4600;

-- ------------------------------------------------------------------ reports
-- NOTE ON THE PRIMARY KEY: (user_id, id), not id alone.
-- Report ids are human-facing (CA-4520) and the seed caseload uses fixed ones
-- so the scripted demo beats stay reproducible. A global text PK would mean the
-- second account to sign up collides on every seed row. Scoping the key to the
-- owner keeps the ids stable AND makes "your ledger is yours" structural.
create table if not exists public.reports (
  id                    text not null,
  user_id               uuid not null references auth.users (id) on delete cascade,
  lat                   double precision not null,
  lng                   double precision not null,
  place                 text not null default '',
  category              text not null check (category in
                          ('pothole', 'storm_water_drain', 'sewage_overflow',
                           'garbage', 'streetlight', 'other')),
  severity              text not null check (severity in ('small', 'medium', 'large')),
  detection_confidence  real not null default 0,
  photo_url             text not null default '',
  after_photo_url       text,
  a_hash                text,
  status                text not null check (status in
                          ('reported', 'filed', 'acknowledged', 'transferred',
                           'past_sla', 'escalated', 'claims_done', 'verified_fixed')),
  routing               jsonb not null default '{}'::jsonb,
  created_at            bigint not null,
  sla_deadline          bigint not null,
  filed_to              text[] not null default '{}',
  supporters            integer not null default 0,
  escalation_post_id    text,
  is_seed               boolean not null default false,
  inserted_at           timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists reports_user_created_idx
  on public.reports (user_id, created_at desc);
create index if not exists reports_user_status_idx
  on public.reports (user_id, status);

-- --------------------------------------------------------- timeline events
create table if not exists public.timeline_events (
  id         bigint generated always as identity primary key,
  report_id  text not null,
  user_id    uuid not null references auth.users (id) on delete cascade,
  at         bigint not null,
  kind       text not null,
  detail     text not null default '',
  foreign key (user_id, report_id)
    references public.reports (user_id, id) on delete cascade
);

create index if not exists timeline_report_idx
  on public.timeline_events (report_id, at);

-- ----------------------------------------------------------------- supports
create table if not exists public.report_supports (
  report_id  text not null,
  user_id    uuid not null references auth.users (id) on delete cascade,
  at         bigint not null,
  primary key (report_id, user_id),
  foreign key (user_id, report_id)
    references public.reports (user_id, id) on delete cascade
);

create or replace function public.sync_supporter_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_report text := coalesce(new.report_id, old.report_id);
  v_user   uuid := coalesce(new.user_id, old.user_id);
begin
  update public.reports r
     set supporters = (
       select count(*)
         from public.report_supports s
        where s.report_id = r.id
          and s.user_id = r.user_id
     )
   where r.id = v_report
     and r.user_id = v_user;
  return null;
end;
$$;

drop trigger if exists report_supports_sync on public.report_supports;
create trigger report_supports_sync
  after insert or delete on public.report_supports
  for each row execute function public.sync_supporter_count();

-- ------------------------------------------------------------------ outbox
create table if not exists public.outbox_items (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users (id) on delete cascade,
  report_id           text,
  kind                text not null check (kind in ('complaint', 'reply', 'post', 'rti')),
  at                  bigint not null,
  intended_to         text not null,
  actually_to         text not null,
  subject             text not null default '',
  body                text not null default '',
  recipient_verified  boolean not null default false,
  delivered           boolean not null default true,
  -- MATCH SIMPLE: a null report_id (an item not tied to a report) skips the
  -- check rather than failing it.
  foreign key (user_id, report_id)
    references public.reports (user_id, id) on delete cascade
);

create index if not exists outbox_user_at_idx
  on public.outbox_items (user_id, at desc);

-- ------------------------------------------------------- profile on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)),
    new.email
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------ id generator
create or replace function public.next_report_id()
returns text
language sql
volatile
as $$
  select 'CA-' || nextval('public.report_id_seq')::text;
$$;

-- ------------------------------------------------------------- SLA sweep
-- Promotes the CALLER'S OWN overdue reports. `p_now` is supplied by the client
-- because the demo clock owns the definition of "now"; the function still
-- decides what that instant MEANS, and cannot be tricked into closing anything
-- (verified_fixed is unreachable from here by construction).
create or replace function public.civic_sweep(p_now bigint)
returns table (id text, status text)
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- filed / acknowledged / transferred past the deadline -> past_sla
  with promoted as (
    update public.reports r
       set status = 'past_sla'
     where r.user_id = auth.uid()
       and r.status in ('filed', 'acknowledged', 'transferred')
       and p_now > r.sla_deadline
    returning r.id, r.user_id
  )
  insert into public.timeline_events (report_id, user_id, at, kind, detail)
  select p.id, p.user_id, p_now, 'past_sla',
         'SLA breached — authority missed its own published deadline'
    from promoted p;

  -- past_sla for 6h+ -> escalated
  with escalated as (
    update public.reports r
       set status = 'escalated',
           escalation_post_id = coalesce(r.escalation_post_id, 'post_' || r.id)
     where r.user_id = auth.uid()
       and r.status = 'past_sla'
       and p_now > r.sla_deadline + 6 * 3600000
    returning r.id, r.user_id
  )
  insert into public.timeline_events (report_id, user_id, at, kind, detail)
  select e.id, e.user_id, p_now, 'escalated', 'Published to the public ledger'
    from escalated e;

  return query
    select r.id, r.status
      from public.reports r
     where r.user_id = auth.uid()
       and r.status in ('past_sla', 'escalated');
end;
$$;

-- ---------------------------------------------------------------------- RLS
alter table public.profiles        enable row level security;
alter table public.reports         enable row level security;
alter table public.timeline_events enable row level security;
alter table public.report_supports enable row level security;
alter table public.outbox_items    enable row level security;

-- profiles
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated using (id = (select auth.uid()));

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- reports: owner-scoped in every direction. This is the "only a citizen can
-- close their own report" rule, enforced by the database rather than the UI.
drop policy if exists reports_select_own on public.reports;
create policy reports_select_own on public.reports
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists reports_insert_own on public.reports;
create policy reports_insert_own on public.reports
  for insert to authenticated with check (user_id = (select auth.uid()));

drop policy if exists reports_update_own on public.reports;
create policy reports_update_own on public.reports
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists reports_delete_own on public.reports;
create policy reports_delete_own on public.reports
  for delete to authenticated using (user_id = (select auth.uid()));

-- timeline
drop policy if exists timeline_select_own on public.timeline_events;
create policy timeline_select_own on public.timeline_events
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists timeline_insert_own on public.timeline_events;
create policy timeline_insert_own on public.timeline_events
  for insert to authenticated with check (user_id = (select auth.uid()));

-- supports
drop policy if exists supports_select_own on public.report_supports;
create policy supports_select_own on public.report_supports
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists supports_insert_own on public.report_supports;
create policy supports_insert_own on public.report_supports
  for insert to authenticated with check (user_id = (select auth.uid()));

drop policy if exists supports_delete_own on public.report_supports;
create policy supports_delete_own on public.report_supports
  for delete to authenticated using (user_id = (select auth.uid()));

-- outbox
drop policy if exists outbox_select_own on public.outbox_items;
create policy outbox_select_own on public.outbox_items
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists outbox_insert_own on public.outbox_items;
create policy outbox_insert_own on public.outbox_items
  for insert to authenticated with check (user_id = (select auth.uid()));

drop policy if exists outbox_delete_own on public.outbox_items;
create policy outbox_delete_own on public.outbox_items
  for delete to authenticated using (user_id = (select auth.uid()));
