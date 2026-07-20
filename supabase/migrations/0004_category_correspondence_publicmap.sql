-- Three related changes: auto-identified category provenance, real
-- correspondence threads, and a community-readable map.

-- ---------------------------------------------------- 1. category provenance
-- An authority receiving an auto-classified complaint is entitled to know it
-- was auto-classified, and that a human confirmed it before filing.
alter table public.reports
  add column if not exists category_source text not null default 'user'
    check (category_source in ('model', 'heuristic', 'user')),
  add column if not exists category_confidence real not null default 0;

-- ------------------------------------------------------- 2. correspondence
-- Inbound replies from authorities were classified and then thrown away — only
-- the resulting status change survived. Without the bodies there is no thread
-- to show, and no evidence trail behind a status like "transferred".
--
-- A separate table rather than a `direction` column on outbox_items: `kind`
-- there is a CHECK-constrained enum meaning "what we sent", and
-- intended_to/actually_to encode the sandbox invariant that outbound mail
-- always lands in the demo sink. Inbound mail has neither property.
create table if not exists public.inbound_replies (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  report_id  text not null,
  at         bigint not null,
  from_addr  text not null,
  subject    text not null default '',
  body       text not null default '',
  -- The ReplyKind the correspondence handler assigned, stored so the thread can
  -- render the classification without re-running classifyReply on every paint.
  kind       text not null check (kind in
               ('acknowledged', 'query', 'jurisdiction_transfer',
                'claims_done', 'rejected')),
  foreign key (user_id, report_id)
    references public.reports (user_id, id) on delete cascade
);

create index if not exists inbound_replies_report_idx
  on public.inbound_replies (user_id, report_id, at);

-- Per-report outbox reads had no supporting index — the only one was
-- (user_id, at desc), which is the account-wide feed.
create index if not exists outbox_report_idx
  on public.outbox_items (user_id, report_id, at);

alter table public.inbound_replies enable row level security;

drop policy if exists inbound_select_own on public.inbound_replies;
create policy inbound_select_own on public.inbound_replies
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists inbound_insert_own on public.inbound_replies;
create policy inbound_insert_own on public.inbound_replies
  for insert to authenticated with check (user_id = (select auth.uid()));

drop policy if exists inbound_delete_own on public.inbound_replies;
create policy inbound_delete_own on public.inbound_replies
  for delete to authenticated using (user_id = (select auth.uid()));

-- ------------------------------------------------------ 3. community map
-- A public accountability ledger that only its author can see is not a ledger.
-- SELECT opens to every signed-in citizen; INSERT/UPDATE/DELETE stay strictly
-- owner-scoped, so "only the citizen who filed it can close it" is unchanged —
-- that refusal is enforced here, not in the UI.
--
-- THE is_seed CLAUSE IS LOAD-BEARING. Every account is seeded with the same 14
-- fixed report ids (CA-4520 and friends). A plain `using (true)` would stack N
-- overlapping copies of each seed pin on the map, one per account. Excluding
-- other people's seeds means each citizen sees their own demo caseload plus
-- everyone's real reports.
drop policy if exists reports_select_own on public.reports;
create policy reports_select_community on public.reports
  for select to authenticated
  using (is_seed = false or user_id = (select auth.uid()));

-- Timelines must follow, or a community pin opens to an empty history.
drop policy if exists timeline_select_own on public.timeline_events;
create policy timeline_select_community on public.timeline_events
  for select to authenticated
  using (
    exists (
      select 1 from public.reports r
       where r.user_id = timeline_events.user_id
         and r.id = timeline_events.report_id
         and (r.is_seed = false or r.user_id = (select auth.uid()))
    )
  );

-- Supports stay private: the aggregate count on reports.supporters is public,
-- but WHO backed a report is not.
