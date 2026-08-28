-- WhatsApp intake: filing a report by messaging a photo to a number.
--
-- A citizen who files over WhatsApp has no account, no session and no cookie,
-- so two things the in-app flow takes for granted have to be added: a way to
-- address one report without being logged in, and somewhere to hold the
-- half-finished report between the photo message and the location message.

-- ---------------------------------------------------------------- public_token
-- The reports primary key is (user_id, id) — deliberately, because seed ids
-- like CA-4520 repeat across accounts. So a bare report id does NOT identify a
-- row, and `/track/CA-4520` is ambiguous by construction. Every report gets an
-- unguessable token instead; report ids come from a sequence and would
-- otherwise be trivially enumerable by anyone handed one link.
--
-- Backfilled for existing rows by the default, so any report can be shared this
-- way later, not just WhatsApp ones.
alter table public.reports
  add column if not exists public_token uuid not null default gen_random_uuid();

create unique index if not exists reports_public_token_key
  on public.reports (public_token);

-- --------------------------------------------------------------------- source
-- Provenance, and an honest one. The app's privacy guarantee is that faces are
-- pixelated and EXIF stripped ON THE DEVICE before upload (src/lib/imaging.ts,
-- which is "use client" and needs canvas + TF.js). A photo arriving from a
-- Twilio media URL has had none of that; the server can only strip EXIF. This
-- column keeps that weaker guarantee visible in the data rather than implied
-- away, so the UI can say which intake path a photo came through.
alter table public.reports
  add column if not exists source text not null default 'app'
    check (source in ('app', 'whatsapp'));

-- --------------------------------------------------------- whatsapp_sessions
-- A WhatsApp photo carries no GPS — location arrives as a separate message —
-- so filing is a two-step conversation and the first step needs somewhere to
-- wait. One row per in-flight conversation, deleted once the report is filed.
--
-- Keyed by a SHA-256 of the E.164 number, never the number itself: Twilio
-- re-sends the sender on every request, so the raw phone number is only ever
-- needed for the length of one request and is not worth persisting.
create table if not exists public.whatsapp_sessions (
  phone_hash text primary key,
  state      text not null check (state in ('awaiting_location')),
  photo_url  text not null,
  photo_path text not null,
  caption    text not null default '',
  -- Classification is done at photo time so the location step stays fast.
  category            text not null,
  severity            text not null,
  category_confidence real not null default 0,
  reason              text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.whatsapp_sessions enable row level security;

-- No policies, deliberately. Only the service-role client (which bypasses RLS)
-- ever touches this table; under the anon or authenticated key it reads and
-- writes nothing. That keeps the project-wide invariant intact — every policy
-- that exists is owner-scoped — for a table that has no owner to scope to.
