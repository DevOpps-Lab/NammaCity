-- Outbound WhatsApp: telling the citizen what happened to their report.
--
-- Intake (0009) is one-directional. A citizen sends a photo and a pin, gets a
-- tracking link, and then never hears from us again — including at the one
-- moment the loop actually needs them, when an authority claims the defect is
-- fixed and only a human can confirm it. The filing reply literally promises
-- "we'll ask for an after-photo"; these two tables are what makes that true.

-- ------------------------------------------------------------ whatsapp_notify
-- Where to reach the filer of one report.
--
-- This is a deliberate walk-back of a privacy choice made in 0009. Sessions are
-- keyed by a SHA-256 of the number precisely so the raw number never persists —
-- but a hash cannot be messaged, and an outbound notification has to address
-- something. So the number is stored, and the scope of that is bounded three
-- ways: one row per report, never joined into any report SELECT, and deleted as
-- soon as the report reaches a terminal state (see lib/whatsapp/notify.ts) or
-- the report itself is deleted.
--
-- Separate table rather than a column on `reports` on purpose: REPORT_COLUMNS
-- in lib/db.ts is an explicit list that several public, unauthenticated paths
-- select through (/track, the community Feed, the Map). A phone number on that
-- row is one forgotten column-list edit away from being served to the world.
create table if not exists public.whatsapp_notify (
  report_owner uuid not null,
  report_id    text not null,
  -- E.164, no `whatsapp:` prefix — the adapter adds it.
  phone        text not null,
  created_at   timestamptz not null default now(),
  primary key (report_owner, report_id),
  foreign key (report_owner, report_id)
    references public.reports (user_id, id) on delete cascade
);

alter table public.whatsapp_notify enable row level security;
-- No policies, same discipline as whatsapp_sessions: service-role only. Under
-- the anon or authenticated key this table reads and writes nothing.

-- ----------------------------------------------------- whatsapp_notifications
-- The outbound ledger. Mirrors `outbox_items` for email: the message is
-- recorded first and marked delivered second, so a send that fails leaves
-- evidence rather than silence.
--
-- The unique key IS the idempotency mechanism. It matters because the trigger
-- is `civic_sweep_owner`, which returns every past_sla/escalated report for the
-- owner on every call, not just the ones that transitioned on this call. Rather
-- than reconstruct "what is new" at the call site, an insert that conflicts is
-- simply a notification already handled.
create table if not exists public.whatsapp_notifications (
  id           uuid primary key default gen_random_uuid(),
  report_owner uuid not null,
  report_id    text not null,
  kind         text not null check (kind in
                 ('claims_done', 'past_sla', 'escalated', 'verified_fixed')),
  phone        text not null,
  body         text not null,
  at           bigint not null,
  delivered    boolean not null default false,
  provider_message_id text,
  -- Non-null after a failed attempt. Twilio 63016 ("outside the allowed
  -- window") is the expected one and is not a bug: WhatsApp only permits a
  -- freeform business message within 24h of the citizen's last inbound
  -- message. An SLA breach three days later cannot be delivered without an
  -- approved message template. Recorded, not hidden.
  delivery_error text,
  unique (report_owner, report_id, kind),
  foreign key (report_owner, report_id)
    references public.reports (user_id, id) on delete cascade
);

create index if not exists whatsapp_notifications_pending_idx
  on public.whatsapp_notifications (delivered, at)
  where delivered = false;

alter table public.whatsapp_notifications enable row level security;
-- No policies. Service-role only, as above.

-- `delivered` claims less than its name suggests, and the difference matters on
-- a product whose whole argument is that "the authority says it's done" is not
-- the same as "it is done". Twilio returning a message SID means it ACCEPTED
-- the message, not that a phone ever showed it: delivery is asynchronous and
-- can still fail afterwards (the number never joined the sandbox, the handset
-- is unreachable, the 24h window closed between queue and send). Anything
-- reported to a user from this column should say "sent", never "read".
comment on column public.whatsapp_notifications.delivered is
  'Twilio ACCEPTED and queued the message (a real message SID came back) — NOT proof the citizen received or read it. Delivery to the handset is asynchronous and can still fail afterwards (number never joined the sandbox, handset unreachable). Treat as "handed off", not "seen".';
