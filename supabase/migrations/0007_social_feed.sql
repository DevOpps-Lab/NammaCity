-- Public accountability layer: a social feed (comments), a public "Namma
-- Chennai" post timeline, and community-verified closure.
--
-- CLOSURE CHANGE (deliberate): until now `verified_fixed` was reachable only by
-- the report OWNER (owner-scoped UPDATE RLS + client confirmFixed). The product
-- now lets ANY resident — or a verified authority-submitted photo — close a
-- case, gated by photo verification instead of owner-identity. That is done
-- through the controlled `verify_and_close` function below, NOT by relaxing the
-- owner-only UPDATE policy (which still guards status/escalation/delete for
-- every other transition).

-- ------------------------------------------------------------ comments (feed)
-- Mirrors report_supports (0005): report_id is per-account, so the row names the
-- report as (report_owner, report_id). `author_area` is denormalized from the
-- report's place so the feed can render "A resident · <area>" without exposing
-- profiles.display_name (which stays owner-only). Anonymous by design.
create table if not exists public.report_comments (
  id           uuid primary key default gen_random_uuid(),
  report_id    text not null,
  report_owner uuid not null,
  author       uuid not null references auth.users (id) on delete cascade,
  author_area  text,
  at           bigint not null,
  body         text not null,
  foreign key (report_owner, report_id)
    references public.reports (user_id, id) on delete cascade
);

create index if not exists report_comments_report_idx
  on public.report_comments (report_owner, report_id, at);

alter table public.report_comments enable row level security;

-- Community SELECT: readable when the underlying report is visible (mirrors
-- timeline_select_community from 0004: non-seed, or your own seed).
drop policy if exists comments_select_community on public.report_comments;
create policy comments_select_community on public.report_comments
  for select to authenticated
  using (exists (
    select 1 from public.reports r
     where r.id = report_comments.report_id
       and r.user_id = report_comments.report_owner
       and (r.is_seed = false or r.user_id = (select auth.uid()))
  ));

-- You may post/delete only as yourself.
drop policy if exists comments_insert_author on public.report_comments;
create policy comments_insert_author on public.report_comments
  for insert to authenticated with check (author = (select auth.uid()));

drop policy if exists comments_delete_author on public.report_comments;
create policy comments_delete_author on public.report_comments
  for delete to authenticated using (author = (select auth.uid()));

-- ------------------------------------------------ public posts (X timeline)
-- The in-app "Namma Chennai" timeline. `source` records whether a post actually
-- went to X (with tweet_id/url) or was simulated. Genuinely public content — no
-- per-account seeds — so SELECT is open to every signed-in citizen.
create table if not exists public.public_posts (
  id         uuid primary key default gen_random_uuid(),
  report_id  text,
  kind       text not null check (kind in ('escalation', 'update', 'summary')),
  body       text not null,
  source     text not null default 'simulated' check (source in ('simulated', 'x')),
  tweet_id   text,
  tweet_url  text,
  author     uuid not null references auth.users (id) on delete cascade,
  at         bigint not null
);

create index if not exists public_posts_at_idx on public.public_posts (at desc);

alter table public.public_posts enable row level security;

drop policy if exists posts_select_all on public.public_posts;
create policy posts_select_all on public.public_posts
  for select to authenticated using (true);

drop policy if exists posts_insert_author on public.public_posts;
create policy posts_insert_author on public.public_posts
  for insert to authenticated with check (author = (select auth.uid()));

-- ------------------------------------------------- community-verified closure
-- SECURITY DEFINER so it can close a report the caller does not own — but ONLY
-- through this function, which requires a verifying photo (p_after_url). The
-- app layer runs /api/verify-image (place-match + defect-resolved) BEFORE
-- calling this; the mandatory photo here is the DB-level floor. `p_now` is the
-- client-authoritative instant (the demo clock), same contract as civic_sweep.
create or replace function public.verify_and_close(
  p_owner     uuid,
  p_report_id text,
  p_after_url text,
  p_source    text,
  p_now       bigint
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_closed boolean := false;
begin
  if p_after_url is null or length(trim(p_after_url)) = 0 then
    raise exception 'verify_and_close requires a verifying photo';
  end if;

  update public.reports
     set status = 'verified_fixed',
         after_photo_url = p_after_url
   where id = p_report_id
     and user_id = p_owner
     and status <> 'verified_fixed';

  if found then
    insert into public.timeline_events (report_id, user_id, at, kind, detail)
    values (p_report_id, p_owner, p_now, 'verified_fixed',
            'Verified fixed by ' || coalesce(nullif(trim(p_source), ''), 'a resident'));
    v_closed := true;
  end if;

  return v_closed;
end;
$$;

grant execute on function public.verify_and_close(uuid, text, text, text, bigint)
  to authenticated;
