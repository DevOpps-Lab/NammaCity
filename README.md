# CivicAgent

A citizen-verified accountability ledger for civic defects.

Photograph a pothole or broken drain. Agents identify the responsible ward and
agencies, file against **all** plausibly-responsible bodies at once, run a clock
against the authority's **own published** service standard, and escalate publicly
when that standard is missed. **A report closes only on a verified after-photo** —
never on an authority's word alone.

```bash
npm run dev              # http://localhost:3000
npm run build
npm run verify:guards    # adversarial checks on the refusal paths
npm run verify:rls       # two-account check that direct writes stay owner-scoped
npm run verify:whatsapp  # replays the whole WhatsApp conversation, no Twilio needed
npm run demo:whatsapp    # forces a breach so escalation is demonstrable on stage
```

## The four tabs

**Report** — photograph a defect. It is redacted on-device, the severity is
measured, the category is identified, your ward is resolved and the responsible
agencies are looked up — all *before* you commit. You see what it concluded and
tap once.

**My Reports** — your ledger, with SLA countdowns, the correspondence thread with
each authority, and a first-class *Awaiting you* filter for reports an authority
claims to have fixed. That filter exists because `claims_done` is the one state
where the loop cannot close without a human.

**Feed** — every citizen's cases as a public, anonymous social feed. Anyone can
back a case, comment on it, and — if they have seen it fixed — verify it with a
photo. A second view is the **Namma Chennai** timeline: the public posts that
escalations and status updates fire — **real posts to Bluesky** (free, no API
credits) when configured, with X as an alternative, otherwise shown in-app as
simulated.

**Map** — every citizen's reports, city-wide, clustered by status.

> **Closure model.** Closure is *community-verified*: any resident can close a
> case, and an authority email that claims "done" **and attaches a photo** can
> too — but **only** if the photo passes verification (same place, defect gone).
> A claim with no verified photo never closes. The photo is the anti-fraud gate
> that replaces "only the filer can close"; it is enforced by the
> `verify_and_close` database function, which requires a photo.

## A fifth way in: WhatsApp

Most people who can photograph a pothole do not want to install an app to report
it. So there is a second intake path with no app, no account and no login:
message a photo to the number, then share a location pin.

```
citizen ──photo──▶ /api/whatsapp/inbound ──▶ classify (Gemini)
        ──pin────▶                       ──▶ resolve authority (tiers 1-4)
                                          ──▶ file + email the agency
        ◀──"Filed as CA-1042 … track it here" ──┘
```

The report travels **the same `fileReport` pipeline** as one filed in the app —
same sequence-minted id, same tiered routing, same SLA source, same complaint
text, same outbox row. It appears on the public Feed and Map like any other.

Three things are genuinely different, and the app says so rather than implying
otherwise:

- **Faces are not blurred.** In-app photos are redacted on-device before upload
  (`src/lib/imaging.ts`, canvas + TF.js). A photo arriving from a Twilio media
  URL has already reached our server, so only EXIF can be stripped. The report
  records `source = 'whatsapp'` and the tracking page states this plainly.
- **The owner is a service account.** `reports.user_id` is NOT NULL, so every
  bot-filed report belongs to one shared intake user. Citizens reach their own
  report through an unguessable `public_token`, which is what makes the tracking
  link work with no login at all.
- **Closing is stricter, not looser.** A tracking link is a bearer credential,
  not an identity — so unlike the app, there is no manual-confirm fallback.
  `/api/track/verify` closes a report only when the vision check independently
  agrees the after-photo shows the same place with the defect gone.

### What comes back to the citizen

An authority claiming "done" is the one state the loop cannot leave without a
human, so the intake reply promises a follow-up and the app now sends one:

| Event | Message | Delivers? |
|---|---|---|
| `claims_done` | "They say it's fixed. It is **not** closed. Send an after-photo." | usually yes |
| `past_sla` | passed the authority's own published deadline | usually **no** |
| `escalated` | published to the public ledger | usually **no** |
| `verified_fixed` | closed on a verified photo | usually yes |

The "usually no" is a WhatsApp platform rule, not a bug: a business may only
send a **freeform** message within **24 hours** of the citizen's last inbound
message. Outside that, Twilio returns error 63016 and delivery needs a
Meta-approved template. Failures are recorded on
`whatsapp_notifications.delivery_error` rather than swallowed, and the tracking
link — which has no such limit — remains the channel that always works.

### Wiring it up (about five minutes)

1. Twilio Console → Messaging → **Try it out** → Send a WhatsApp message.
   Activate the sandbox and note the join keyword.
2. Sandbox settings → *When a message comes in*: `https://<your-host>/api/whatsapp/inbound` (POST).
3. From your phone, WhatsApp `join <keyword>` to **+1 415 523 8886**.
4. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `PUBLIC_BASE_URL`.

The sandbox session expires three days after joining — rejoin before a demo.
Local development needs a tunnel (ngrok); if the tunnel rewrites the host, set
`TWILIO_WEBHOOK_URL` to the URL you configured, verbatim, or the signature check
will fail.

`/api/whatsapp/inbound` is the one route in this codebase where an
unauthenticated request writes to the database and sends mail, so the
`X-Twilio-Signature` check is load-bearing and **fails closed** — no token, no
signature, or a bad signature is a 403 before anything else is even read.

### Demoing it without Twilio

`npm run verify:whatsapp` replays the entire two-message conversation against a
local dev server with correctly-signed requests, and asserts what landed in the
database: the report, its routing tier, the outbox row, the cleared session, the
notification ledger, and every refusal path on the closing endpoint.

`npm run demo:whatsapp` moves the newest WhatsApp report's deadline seven hours
into the past and runs the **real** sweep over it, so breach → escalation →
public post → notification is demonstrable without waiting out an SLA. It prints
the tracking link to finish the loop with an after-photo.

## Setup

Accounts and reports live in Supabase Postgres, so the app needs a project
before it will run.

1. **Create a Supabase project** (free tier is enough).

2. **Apply the migrations** — paste each file into the SQL editor in order:

   ```
   supabase/migrations/0001_init.sql    # tables, RLS, SLA sweep, triggers
   supabase/migrations/0002_storage.sql # redacted-photo bucket + policies
   supabase/migrations/0003_oauth_profiles.sql              # Google name/avatar
   supabase/migrations/0004_category_correspondence_publicmap.sql
   supabase/migrations/0005_community_support.sql           # per-supporter voice
   supabase/migrations/0006_email_dispatch.sql              # real-send bookkeeping
   supabase/migrations/0007_social_feed.sql                 # comments, public posts, verify_and_close
   supabase/migrations/0008_bluesky_source.sql              # 'bluesky' as a post source
   supabase/migrations/0009_whatsapp_intake.sql             # public_token, source, sessions
   supabase/migrations/0010_sweep_owner.sql                 # SLA sweep for ownerless reports
   supabase/migrations/0011_whatsapp_notify.sql             # outbound notification ledger
   ```

3. **Turn off email confirmation** for the demo:
   Authentication → Sign In / Providers → Email → **Confirm email: off**.
   Left on, Supabase's built-in SMTP rate-limits to a couple of mails an hour,
   which will strand you mid-demo. The signup form handles both configurations —
   with confirmation on it tells you to check your inbox instead of hanging.

4. **Wire the env** — `cp .env.example .env.local`, then fill in:

   | Variable | For |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | required — Settings → API |
   | `SUPABASE_SERVICE_ROLE_KEY` | the **secret** key — lets the inbound webhook write with no session |
   | `GMAIL_USER`, `GMAIL_APP_PASSWORD` | real email send + receive (2FA + App Password) |
   | `DEMO_AUTHORITY_EMAIL` | where authority mail is routed for the demo |
   | `INBOUND_POLL_SECRET` | guards the inbound sweep |
   | `GEMINI_API_KEY` | optional — auto category + after-photo verification |
   | `BLUESKY_IDENTIFIER`, `BLUESKY_APP_PASSWORD` | optional — real public posts (free) |
   | `X_API_KEY` / `X_API_SECRET` / `X_ACCESS_TOKEN` / `X_ACCESS_SECRET` | optional — X posting (needs paid credits) |
   | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | optional — file a report over WhatsApp |
   | `PUBLIC_BASE_URL` | absolute origin for tracking links sent over WhatsApp |

   Every optional block degrades gracefully when unset.

5. `npm run dev`, create an account. The ledger starts **empty** — auto-seeding
   is disabled so a demo shows only real, end-to-end activity. (Re-enable
   `db.seedIfEmpty` in `src/lib/store.ts` to restore the sample caseload.)

### Google sign-in (optional)

Email/password works without this. To enable the **Continue with Google**
button:

1. **Google Cloud Console** → APIs & Services → Credentials →
   *Create OAuth client ID* → **Web application**.
2. Authorised redirect URI — this is your **Supabase** callback, not your app's:

   ```
   https://<project-ref>.supabase.co/auth/v1/callback
   ```

3. Copy the client ID and secret into Supabase → Authentication →
   Sign In / Providers → **Google** → enable, paste, save.
4. Confirm Authentication → URL Configuration lists your app origin
   (`http://localhost:3000/**`) in the redirect allow list.

The button self-diagnoses: with the provider disabled it says so and points at
the email form rather than failing silently.

Google returns `full_name` and `picture` where our own form sends
`display_name`, so `0003_oauth_profiles.sql` coalesces across both shapes —
without it an OAuth user lands with a blank name and the UI falls back to the
email local-part.

> The anon key is meant to reach the browser. Every table is owner-scoped by RLS,
> so on its own it reads nothing.

## Why this shape

Filing a complaint is a solved, commoditised feature — India has at least seven
government apps that do it. The problem is what happens next:

| System | Reported | Resolved | Rate |
|---|---|---|---|
| BBMP Sahaaya (Bengaluru), 1 May–6 Jun 2019 | 11,785 | **6** | **~0.05%** |
| FixMyStreet UK (independently measured) | — | — | ~34% |
| Swachhata / MCD 311 (**self**-reported) | — | — | 93–95% |

UK councils are not three times better than Indian ULBs. The difference is **who
marks the ticket closed**. Indian systems let the accused department close its
own ticket — Chennai has documented complaints closed using photos taken at a
different location, and BBMP's Sahaaya closed 1,348 complaints for "unknown
reasons."

So the contribution here is not filing. It is **making closure verifiable by the
citizen rather than declarable by the authority**, and attaching consequence to
silence.

## Architecture

### Tiered authority resolver (`src/lib/routing.ts`)

Converting a GPS coordinate to "who is responsible" is the actual hard problem.
There is no national API: LGD has every ward's code but no geometry, Survey of
India stops at taluk, Bhuvan publishes no municipal wards, and open ward polygons
exist for roughly 28 of India's ~4,800 urban local bodies.

| Tier | Source | Confidence | Measured |
|---|---|---|---|
| 1 | Local GCC ward polygons (200 wards, 16 zones) | high | 1–13 ms |
| 2 | OSM via Nominatim reverse geocode | medium/low | ~300 ms |
| 4 | Refuse and ask for confirmation | unresolved | — |

Every result reports **which tier answered**. A system that says "municipality
only, low confidence, please confirm" is more trustworthy than one that silently
guesses a ward.

> The originally specced Tier 1 — the GCC ArcGIS REST service — is **dead**
> (HTTP 500, probed 18 Jul 2026), and the Esri Living Atlas ward item is
> inaccessible. Tier 1 is now a local static dataset, which is also strictly more
> reliable: it cannot fail on venue wifi. Overpass was dropped for Nominatim
> after Overpass returned 504 under load.

### Filing wide on purpose

Where jurisdiction is ambiguous — storm-water drain vs. sewer is the classic
Chennai case — we file to **every** plausible agency rather than guessing.
Bombay HC, *High Court on its own motion v. State of Maharashtra* (13 Oct 2025)
refuses to let agencies create "no-man's zones" of responsibility: where they
dispute who owns a defect, they are ordered to pay equally.

A jurisdiction transfer is **not** a closure. The clock keeps running.

### The two refusals

Both are verified by `scripts/verify-guards.ts`.

**1. Closure requires a *verified photo*, never a claim** (`src/lib/verify-vision.ts`,
`src/app/api/verify-image`, `verify_and_close`)

Published pothole detection tops out around 53% mAP@50 — potholes are the
*weakest* class in the standard RDD2022 benchmark. So a status update alone,
or a detector that sees nothing, is not proof of repair. Closing on that would
algorithmically reproduce the exact fraud this product exists to stop.

So a case closes **only** when a photo is submitted and *verified* — same place,
defect gone — by `/api/verify-image` (Gemini vision), or, when that is
unavailable, by the resident confirming their own after-photo. This is open to
**any** resident, and to an authority email that claims done **and attaches a
photo** that passes the same check. It is enforced at the database layer by
`verify_and_close`, which refuses to run without a photo; `civic_sweep()` still
cannot reach `verified_fixed` on its own. `evaluateAfterPhoto()`'s advisory
`autoClose` remains literal `false` — the close is a separate, photo-gated step.

> This is a deliberate shift from the original "only the citizen who filed it can
> close it". The anti-fraud guarantee moved from *who* closes to *what evidence*
> closes: no verified photo, no closure.

**2. The escalation composer strips unsafe content** (`src/lib/escalation.ts`)

We post from one official account, so we are the publisher with no intermediary
safe harbour. Consequently:

- **Facts only** — complaint ID, filing date, elapsed days, the authority's own
  published standard. No characterisation.
- **Institutions, never individuals.** *R. Rajagopal v. State of TN* (1994) holds
  the State cannot sue for defamation; naming an officer forfeits that shield.
- **No corruption/dishonesty allegations** — outside the BNS s.356 Exception 2
  public-conduct shield, and where officials actually file complaints.
- **Hard political firewall.** In the Agra case a man was arrested over a pothole
  video that *also* carried a remark about the Chief Minister. The civic fact was
  never the trigger. Enforced by a deterministic blocklist, independent of any
  model call.
- **No links.** X charges $0.015/post but **$0.20 with a link** — 13×. Images
  attach natively.
- **Template rotation**, because X forbids "substantially similar content" and
  account termination would end the product faster than any lawsuit.

These guardrails run **before any post, on every platform** — `guardText()` is
re-applied server-side in `/api/x-post` and the inbound handler, independent of
where the post lands. See [Social posting](#social-posting-blueskyx) for the
transport.

### Honest metrics

The header publishes an independently computable **verified** fix rate —
authority claims explicitly do not count. The map is labelled "reports," not
"problems," because reporting volume is a biased proxy for actual conditions
(Mumbai 2025: Powai 1,802 pothole complaints vs. Colaba under 100; the same
skew is documented across 20M NYC 311 requests, the UK, and Brussels).

### Auto-identification, and why it is not silent (`src/app/api/classify`)

`detect.ts` measures severity from pixels and refuses to infer the category —
colour statistics cannot separate garbage from sandbags, and filing to the wrong
agency on that basis would be the same confident guessing the tiered resolver
exists to avoid. A vision model can do what the heuristic could not, so the
Report tab asks one. Three things keep that from becoming a guess:

- It runs **server-side** — the key never reaches the browser, and the endpoint
  sits behind the auth proxy so it cannot be used to burn quota anonymously.
- It returns a **confidence**, and the UI gates on it. The identified category is
  always on screen with a one-tap Change; below the floor the picker is required.
- With no key, or offline, `/api/classify` reports itself **unconfigured** and
  the citizen picks the category. Degrading to a question is honest; degrading to
  a weak guess is not.

Set `GEMINI_API_KEY` from [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
— the free tier allows roughly 1,500 classifications a day with no card. The
provider is isolated to that one route: the client, the confidence gating and the
fallback all consume a plain `{category, confidence, reason}`, so swapping models
or vendors touches nothing else.

The provenance travels: `category_source` and `category_confidence` are stored on
the report and stated in the complaint body, because an authority receiving an
auto-classified complaint is entitled to know that a human confirmed it.

### Accounts and the ledger (`supabase/migrations/`, `src/lib/db.ts`)

Postgres is the source of truth; Supabase Auth issues the session. Three
decisions are worth calling out.

**The refusals are database-enforced, not UI conventions.** Direct writes to a
report (insert / update / delete) stay owner-scoped by RLS — bypassing the UI
entirely still writes nothing. The one exception is *closure*, which is now
community-verified (see below): it goes through the `security definer`
`verify_and_close` function, which will not run without a verifying photo. So
the boundary moved from *who* writes to *what evidence* closes — still enforced
in Postgres, not the client. `civic_sweep()` still cannot reach `verified_fixed`.

**The primary key is `(user_id, id)`, not `id`.** Report references are
human-facing (`CA-4520`) and stay stable per account. A global text key would
collide the moment a second person filed the same reference.

**Lifecycle times are `bigint` epoch-ms, not `timestamptz`.** The demo clock
compresses an hour into a second, so "now" is a client-controlled quantity.
`civic_sweep(p_now)` takes that instant as a parameter: the client stays the
authority on what time it is, and Postgres stays the authority on what that time
*means*. `verified_fixed` is unreachable from inside the sweep by construction —
the same refusal as the client, at the other end of the wire.

Auto-seeding is now disabled: a real end-to-end demo (file → email → reply →
verify → post) is more convincing than a pre-populated map, and a clean account
shows only genuine activity. The seed builders remain in `src/lib/seed.ts` for
anyone who wants the sample caseload back.

**The map and feed are community-wide.** `0004` opens SELECT to every signed-in
citizen while INSERT/UPDATE/DELETE on a report stay owner-scoped — so anyone can
watch, back and comment on any report, but escalation and RTI remain the filer's.
Closure is the deliberate community exception, gated by a verified photo through
`verify_and_close`. `scripts/verify-rls.mjs` proves the owner-scoping by
attempting a direct close/escalate/delete against PostgREST as a second account.

### Capture pipeline (`src/lib/imaging.ts`, `src/lib/detect.ts`)

Photo → **on-device redaction** → analysis → confirm → file. Nothing is uploaded
before redaction, which is the point: the cheapest way to be safe with
bystanders is for identifiable data to never reach our systems.

- Faces auto-redacted via the browser's native `FaceDetector` where available;
  **tap-to-blur** everywhere else. When the browser can't detect, the UI says so
  rather than implying the photo is clean.
- Redaction is **pixelation, not a reversible blur**.
- Canvas re-encode **strips EXIF** as a side effect. Geolocation is read live
  instead — browsers and messaging apps strip EXIF GPS inconsistently.
- Severity is computed from real pixel statistics (luminance, contrast,
  saturation, dark-region geometry), with explicit penalties for the documented
  confusers: low contrast, glare/wet road, shadow-dominated frames, and
  near-rectangular regions that read as manhole covers or patches.

> **Honest labelling:** `detect.ts` is a classical CV heuristic, **not** a trained
> detector — it computes from real pixels and varies per photo, but it is a
> stand-in for the RDD2022/YOLOv8 model a production build would ship, and the UI
> says so on screen. Confidence is capped at 0.78 because nothing in this field
> earns more on this class.

### Correspondence handler (`src/lib/correspondence.ts`)

Classifies inbound replies into acknowledged / query / jurisdiction-transfer /
claims-done / rejected. Two rules carry the design:

- **A transfer is not a resolution.** It re-files to the named agency and the
  original clock keeps running. The Standing Committee on Public Grievances
  (Dec 2021) found grievances routinely "disposed" by telling the citizen to go
  elsewhere; Mumbai bounced 727 of 10,361 pothole complaints to other agencies.
- **"Done" is not done.** `claims_done` is a distinct state; a verified after-photo
  is what moves it to `verified_fixed` (from any resident, or from an authority
  reply that *attaches* a photo which passes verification). The classifier itself
  can never reach `verified_fixed` — closure is always a separate, photo-gated step.

### Deduplication (`src/lib/dedup.ts`)

Geo proximity first (per-category radius, following FixMyStreet), perceptual
hash to confirm. Deliberately asymmetric: a hash **hit** is strong evidence of
the same defect; a hash **miss** is not evidence of a different one, because
average hashes are not robust to viewpoint change and two people photograph the
same pothole from different angles. Phone GPS at 3–5m is also worse than the
2.5m threshold used in the video literature, so nothing merges silently — the
user is asked.

Closed reports are never merged into: a defect recurring at the same spot is a
new report, and recurrence is itself signal (DARPG logged 5 lakh recurring
grievances 2022–25).

### Sandboxed outbox (`src/lib/outbox.ts`)

Complaints, auto-replies, RTI requests and escalation posts are composed in
full — correct recipient, cited service standard, real body — then routed to a
sink. The Outbox panel shows **intended recipient vs. where it actually went**,
and flags unverified addresses.

### Real email round-trip (`src/lib/email/`, `/api/dispatch`, `/api/inbound/poll`)

The outbox can now actually **send** and the app can **receive and auto-handle**
replies — without ever mailing a real government address.

- **Send.** Filing a report fires `POST /api/dispatch`, which transmits the
  composed complaint over **Gmail SMTP** from the app account
  (`GMAIL_USER`). The `intended_to` stays the real role alias; `actually_to` is
  the demo authority mailbox (`DEMO_AUTHORITY_EMAIL`). Runs as the logged-in
  user, so RLS still scopes every write.
- **Receive.** The app polls its own inbox over **Gmail IMAP** (in-app every few
  seconds + a manual *Check inbox* button; an optional cron can hit
  `/api/inbound/poll` with `INBOUND_POLL_SECRET`). Each reply is matched back to
  its report by the sent **Message-ID** (`In-Reply-To`) — not the `CA-####`
  reference, which is per-account and repeats across seeds.
- **Auto-handle, same rules.** A matched reply runs the *existing*
  `classifyReply` / `applyReply` on the server via the service-role client, so a
  jurisdiction transfer still doesn't reset the clock and — load-bearingly —
  `verified_fixed` stays unreachable. An authority's "done" moves the ticket to
  `claims_done` (**awaiting citizen verification**), never closed. The only path
  to closure remains a citizen after-photo.

One Gmail **App Password** (2FA required) unlocks both SMTP and IMAP. Chosen over
Resend/Postmark because those need a verified custom domain to *receive*, and the
demo runs on Gmail addresses. Fill `GMAIL_USER`, `GMAIL_APP_PASSWORD`,
`DEMO_AUTHORITY_EMAIL`, `SUPABASE_SERVICE_ROLE_KEY` and `INBOUND_POLL_SECRET` in
`.env.local` (see `.env.example`). With Gmail unconfigured the app degrades to
compose-only — exactly the sandboxed behaviour.

### Public feed & community-verified closure (`0007`, `src/lib/verify-vision.ts`)

The **Feed** tab is a public, anonymous social layer over the same reports:
community reads were already open (`0004`), so a card feed with **backing**
(`report_supports`) and **comments** (`report_comments`, new in `0007`, keyed by
author like supports) is mostly presentation. Identity is never shown —
"A resident · <area>" — so no `profiles` exposure is needed.

Closure is now **community-verified**. Anyone who has seen a defect fixed can
submit an after-photo; a **verified authority reply** (a "done" email *with* an
image) can too. The gate is `/api/verify-image` (Gemini vision) comparing the
before and after — *same place? defect gone?* — mapped to the same thresholds as
the advisory `evaluateAfterPhoto`. When Gemini is unavailable the resident
confirms their own photo manually. Either way a photo is mandatory: the
`security definer` `verify_and_close(owner, report_id, after_url, source, now)`
RPC raises if `after_url` is empty, so a closure without evidence is impossible
even at the SQL layer. This is the deliberate reversal of the original
owner-only close — the anti-fraud guarantee moved from *identity* to *evidence*.

### Social posting (Bluesky/X)

Escalations and status updates post to a public account so silence has an
audience. `postSocial()` (`src/lib/social.ts`) tries **Bluesky first**
(`src/lib/bluesky-client.ts`, AT Protocol, free — a handle + app password, no
credits, no approval), then **X** (`src/lib/x-client.ts`, OAuth 1.0a — but X now
requires paid posting credits), then records the post as **simulated** so the
in-app Namma Chennai timeline always shows it. The photo attaches natively; the
post links back with the platform noted. Fires on manual escalate, the
auto-escalation sweep, and every status change (including from real email
replies, server-side). `public_posts` (`0007`, `source` extended in `0008`)
stores each post with its platform + URL.

> X posting is wired and correct — a live test authenticated and reached the API
> — but returns `402 credits-depleted` on the free tier. Bluesky is the working
> free path; the hybrid means no code changes when credits are added.

## Demo

The whole loop is real and end-to-end:

1. **File** a report (photo redacted on-device, category + severity identified,
   ward + agencies resolved before you commit) → a **real complaint email** is
   sent over Gmail to the demo authority mailbox, with the redacted photo.
2. **Reply** to that email as the authority → the app polls the inbox, runs the
   correspondence handler server-side, updates the ticket, and sends an
   **auto-response** — and a status update posts to **Bluesky**.
3. **Verify** with a photo (as any resident) → `/api/verify-image` checks it →
   the case closes as `verified_fixed`. A wrong-place photo is rejected.
4. **Escalate**: flip the **Demo clock** (1s = 1h) so an open report breaches its
   SLA → it auto-escalates → a **real public post** goes out with the photo.
5. Watch it fill the public feed at `bsky.app/profile/<your handle>`.

Other beats: the **Agent Trace** drawer streams triage → routing → authority →
SLA → filing; the **routing reveal** (a Chennai coordinate hits a Tier-1 ward,
elsewhere degrades honestly to a general fallback); the **escalation refusal**
(type "the corrupt minister ignores our ward" and watch it get stripped); the
**dodge** (a jurisdiction-transfer reply re-files but the clock refuses to
reset); **dedup**; the **Outbox** (intended vs. actual recipient); and the
**Tamil toggle**.

State persists to Postgres, so a refresh or another device loses nothing.
**Reset my ledger** (account menu) wipes your reports back to a clean slate.

## Sandboxing

Mail and posts are now sent **for real**, but only to targets we control —
never a real `.gov.in` address or an official municipal handle. Complaints go to
`DEMO_AUTHORITY_EMAIL` (a mailbox we own), and the intended role-based alias
stays visible as `intended_to` in the Outbox. Public posts go to our **own**
Bluesky account. Unverified contacts are flagged `verified: false` in
`src/lib/authorities.ts` and never presented as real. The escalation guardrails
(institutions not individuals, no corruption allegations, political firewall)
apply to every post regardless of platform.

## Stack

Next.js 16.2.10 (Turbopack) · React 19 · Supabase (Postgres, Auth, Storage) ·
MapLibre GL · Turf · Tailwind v4. **Gemini** for category + after-photo
verification · **Gmail** SMTP/IMAP via `nodemailer` + `imapflow` + `mailparser`
· **Bluesky** via `@atproto/api` (`twitter-api-v2` for the X path) ·
**TensorFlow.js / BlazeFace** for on-device face redaction.

> Auth runs through `src/proxy.ts`. Next 16 renamed Middleware to Proxy; the
> file must sit at `src/proxy.ts`, beside `app/`. It refreshes the Supabase
> session cookie and does an *optimistic* redirect — the real authorisation
> boundary is RLS, not that file.

> PWA is framework-native (`src/app/manifest.ts` + hand-written `public/sw.js`).
> **Do not add `next-pwa` or Serwist** — Next 16 defaults to Turbopack and fails
> the build outright when a webpack config is present. The service worker only
> registers in a **production build** (dev unregisters it to avoid stale caches).

## Deployment (installable PWA)

Deployed on **Vercel** — a production build serves the manifest + service worker
over HTTPS, so the app is an **installable PWA** ("Add to Home Screen" on
iOS/Android, opens fullscreen like a native app).

```bash
vercel link --project <name>     # once
# push every var from .env.local to the project (Production), then:
vercel --prod
```

All of `.env.local` must be set as Vercel env vars (Supabase, Gmail, Gemini,
Bluesky). Gmail SMTP/IMAP, Bluesky posting and the inbound poll all run from
Vercel Functions unchanged; the inbound sweep is driven by the in-app poll (a
cron can also hit `/api/inbound/poll` with `INBOUND_POLL_SECRET`). Email/password
login needs no redirect config; Google sign-in needs the deployed origin added
to Supabase → Authentication → URL Configuration.

## Not built (deliberately)

Outbound AI voice calls. The cost model is ₹8–20/call against ~₹1/report, and
TCCCPR (as amended 12 Feb 2025) requires DLT registration and 1600-series
numbering with no AI exemption, while MeitY's IT Amendment Rules 2026 require
provenance labelling on synthetic audio. Beyond legality: one viral clip of a bot
badgering a junior engineer would end the product.
