# n8n workflows

Two workflows that do things the app cannot do for itself. Both are committed as
importable JSON so they can be read here without an n8n login.

Neither replaces the VPS system cron, which keeps sweeping the ledger every five
minutes regardless (`deploy/README.md`).

---

## 1 · Ward scoreboard — `ward-scoreboard.json`

Weekly, publishes the comparison the product exists to make: how many complaints
a department **claims** to have fixed, against how many a resident actually
**verified** with a photograph.

```
Schedule (Mon 09:00) → POST …/rest/v1/rpc/civic_ward_scoreboard → format digest
```

**No application code is involved.** It calls a Postgres function added by
`supabase/migrations/0015_ward_scoreboard.sql`, which returns **counts only** —
no report ids, no photo URLs, no coordinates, no phone numbers.

That is why it is safe to call with the **anon** key, which already ships in the
browser bundle. Do **not** substitute the service-role key: it bypasses every RLS
policy and can write every table, and handing that to a third-party trial account
to read some counts is a bad trade.

**Before it runs:** replace `YOUR-PROJECT` in the URL and both
`PASTE_SUPABASE_ANON_KEY` placeholders.

---

## 2 · Escalation ladder — `escalation-ladder.json`

Daily. Finds reports that have sat at `escalated` for three days with no RTI
filed, and files one.

```
Schedule (daily 10:00) → GET /api/escalation/candidates
                       → split → POST /api/escalation/act → record
```

**Why this rung matters.** A citizen charter deadline binds nobody. The RTI Act
2005 sets a **statutory 30-day deadline** and puts it on a named Public
Information Officer personally. It is the only clock in this product with legal
force, and `composeRti()` had been written and sitting behind a manual button
since early on.

**Where the mail goes:** `DEMO_AUTHORITY_EMAIL`, exactly like every complaint —
never a real Public Information Officer. An RTI naming a real officer, sent
automatically on a schedule as a side effect of a demo, is precisely the harm the
sandbox exists to prevent.

**Before it runs:** replace both `PASTE_INBOUND_POLL_SECRET` placeholders, and
the host if you are not on `namma.duckdns.org`.

Idempotent by construction: a report with an `rti` outbox row stops being a
candidate, and `act` re-checks before sending. A retry after a timeout that
actually succeeded will not file a second RTI — twice reads as harassment, not
persistence.

---

## Importing

n8n → **Workflows → Import from File**, or paste the JSON into a blank canvas.

Secrets are placeholders on purpose so they never enter the repository. Fill them
in the node UI after import, or move them to n8n credentials.

These were authored from the n8n node schemas rather than exported from a live
instance, so if your n8n version disagrees about a node's `typeVersion`, open the
node and re-save it — the parameters are the part that matters.

---

## Scheduling honestly

n8n Cloud meters executions. Weekly and daily are cheap; a one-minute poll is
**1,440 runs/day** and will exhaust a trial quickly. If you demo a fast cadence,
say that it is a demo cadence — the always-on backstop is the system cron on the
VPS.
