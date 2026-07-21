-- Real email dispatch bookkeeping.
--
-- Until now `outbox_items` recorded WHAT would be sent; nothing was actually
-- transmitted (`delivered` defaulted true as a demo fiction). We now send the
-- mail for real over Gmail SMTP, so each row needs to record the outcome and,
-- crucially, the provider Message-ID.
--
-- The Message-ID is load-bearing for the inbound half: an authority's reply
-- carries `In-Reply-To: <that-id>`, which is how the webhook maps a raw inbound
-- email back to the exact (user_id, report_id) it belongs to. Matching on the
-- CA-#### reference alone is not safe — report ids are per-account (the PK is
-- (user_id, id)), so seeded ids collide across accounts.
alter table public.outbox_items
  add column if not exists provider_message_id text,
  add column if not exists delivered_at bigint,
  add column if not exists delivery_error text;

-- Look up the owning row from an inbound In-Reply-To header.
create index if not exists outbox_provider_msgid_idx
  on public.outbox_items (provider_message_id);

-- Outbound dispatch runs as the logged-in user and must flip `delivered` +
-- write `provider_message_id` on its own rows after sending. The original
-- migration granted outbox select/insert/delete but no UPDATE, so add an
-- owner-scoped update policy. Still strictly owner-scoped — a citizen can only
-- mark their OWN outbox rows delivered.
drop policy if exists outbox_update_own on public.outbox_items;
create policy outbox_update_own on public.outbox_items
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- The inbound webhook has no session and uses the service_role key, which
-- bypasses RLS by design and is never exposed to the browser.
