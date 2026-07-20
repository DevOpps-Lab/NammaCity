-- Let a citizen back somebody else's report.
--
-- THE BUG: report_supports had a single `user_id` column doing two different
-- jobs — identifying the supporter AND, via the composite FK to
-- reports(user_id, id), identifying the report's owner. That silently encoded
-- "you may only support your own reports", which was harmless while the ledger
-- was private and became a 409 the moment the map went community-wide:
--
--   insert or update on table "report_supports" violates foreign key
--   constraint "report_supports_user_id_report_id_fkey"
--
-- The button was on screen for other people's reports and did nothing.
--
-- WHY NOT JUST FK TO reports.id: report ids are human-facing and per-account
-- (every citizen is seeded with their own CA-4520), so `id` alone is not
-- unique. A support must therefore name the report as (owner_id, report_id),
-- which means the supporter needs a column of its own.

alter table public.report_supports
  add column if not exists supporter_id uuid references auth.users (id) on delete cascade;

-- Existing rows are all self-supports, so the current user_id is both.
update public.report_supports set supporter_id = user_id where supporter_id is null;

alter table public.report_supports alter column supporter_id set not null;

-- user_id now means one thing only: the report's OWNER. Renaming it would be
-- clearer still, but the composite FK and the trigger both key off it and a
-- rename buys nothing a comment can't.
comment on column public.report_supports.user_id is
  'Owner of the supported report — half of the FK to reports(user_id, id). NOT the supporter.';
comment on column public.report_supports.supporter_id is
  'The citizen adding their voice. May differ from user_id on a community report.';

-- The PK was (report_id, user_id): one support per report per OWNER, which
-- allowed exactly one support in total. It must be one per report per SUPPORTER.
alter table public.report_supports
  drop constraint if exists report_supports_pkey;
alter table public.report_supports
  add constraint report_supports_pkey primary key (user_id, report_id, supporter_id);

-- Count by the report, not by the supporter.
create or replace function public.sync_supporter_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_report text := coalesce(new.report_id, old.report_id);
  v_owner  uuid := coalesce(new.user_id, old.user_id);
begin
  update public.reports r
     set supporters = (
       select count(*)
         from public.report_supports s
        where s.report_id = r.id
          and s.user_id = r.user_id
     )
   where r.id = v_report
     and r.user_id = v_owner;
  return null;
end;
$$;

-- RLS now keys off supporter_id: you may add and withdraw YOUR OWN voice on any
-- report you can see. You still cannot touch the report itself — close,
-- escalate and delete remain owner-only, which is the refusal that matters.
drop policy if exists supports_select_own on public.report_supports;
create policy supports_select_community on public.report_supports
  for select to authenticated using (supporter_id = (select auth.uid()));

drop policy if exists supports_insert_own on public.report_supports;
create policy supports_insert_own on public.report_supports
  for insert to authenticated with check (supporter_id = (select auth.uid()));

drop policy if exists supports_delete_own on public.report_supports;
create policy supports_delete_own on public.report_supports
  for delete to authenticated using (supporter_id = (select auth.uid()));

create index if not exists report_supports_supporter_idx
  on public.report_supports (supporter_id);
