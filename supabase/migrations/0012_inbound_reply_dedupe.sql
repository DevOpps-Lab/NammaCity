-- Make "this email has already been handled" a fact the database enforces.
--
-- /api/inbound/poll flags a message \Seen only AFTER applying it, and applying
-- means an SMTP send, a public timeline post, and sometimes a Gemini vision
-- call — seconds of work. The app polls every 30s (5s with the demo clock) and
-- every open tab polls independently, so any poll starting before the previous
-- one finished re-fetched the same unseen message and applied it again. Each
-- replay sent the citizen another auto-reply: one authority email produced six.
--
-- Marking \Seen first would fix the spam by trading it for silent loss — a
-- crash mid-apply would swallow the reply forever. Instead the inbound row is
-- claimed up front under a unique key: the first caller wins, every concurrent
-- replay conflicts and stops before sending anything.
alter table public.inbound_replies
  add column if not exists provider_message_id text;

-- Partial: rows written before this migration have no id and must not all
-- collide on NULL.
create unique index if not exists inbound_replies_provider_message_id_key
  on public.inbound_replies (provider_message_id)
  where provider_message_id is not null;

comment on column public.inbound_replies.provider_message_id is
  'RFC Message-ID of the inbound email, normalised (no angle brackets). Unique — it is the idempotency key that stops a slow poll from applying the same reply twice.';
