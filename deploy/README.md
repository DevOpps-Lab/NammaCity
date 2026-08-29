# Running CivicAgent on a Vultr VPS

Vercel needs none of this — it is here because a VPS gives us the one thing Vercel
does not: **a real cron**, so SLA breach and escalation advance with nobody
watching. See "The cron" below; it is the reason for the whole exercise.

The app is portable. The only Vercel-specific line in the codebase is an optional
`VERCEL_URL` fallback in `src/lib/base-url.ts`, and `PUBLIC_BASE_URL` already wins
over it.

---

## The instance

**Cloud Compute · High Performance · 2 vCPU / 4 GB / ~80 GB NVMe · Mumbai · Ubuntu 24.04**

Sizing is driven by the **build**, not by traffic. `next build` runs a TypeScript
pass over a dependency tree containing TensorFlow.js, ONNX Runtime, MapLibre and
sharp; `node_modules` lands around 1.5 GB. A 1 GB instance has its build killed.

**Mumbai** because the Supabase project is already `ap-south-1` — same city, so
every database round-trip is local, and the India data-residency story holds.

---

## One-time setup

```bash
ssh root@<ip> 'bash -s' < deploy/setup.sh
```

That adds swap, installs Node 22 and Caddy, creates the `civicagent` user,
configures ufw, and checks that outbound mail ports are open. It stops short of
cloning the repo or writing secrets.

Then, on the box:

`useradd --create-home` populates `/opt/civicagent` with shell dotfiles, so
`git clone .` refuses the directory as non-empty. Initialise in place instead:

```bash
cd /opt/civicagent
sudo -u civicagent git init -q
sudo -u civicagent git remote add origin https://github.com/DevOpps-Lab/NammaCity.git
sudo -u civicagent git fetch -q --depth 1 origin main
sudo -u civicagent git checkout -q -B main FETCH_HEAD
```

### Environment

Copy `.env.local` from the working Vercel configuration and change **three** values:

| Variable | Value |
|---|---|
| `PUBLIC_BASE_URL` | `https://your.domain` — tracking links sent over WhatsApp |
| `TWILIO_WEBHOOK_URL` | `https://your.domain/api/whatsapp/inbound` |
| `INBOUND_POLL_SECRET` | keep it, and finally use it — see the cron |

Everything else is unchanged. `VERCEL_URL` will simply be unset, which
`base-url.ts` already handles.

```bash
chmod 600 .env.local
npm ci
npm run build
```

### Services

```bash
sudo cp deploy/civicagent.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now civicagent

sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/civicagent.example.com/your.real.domain/' /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Point the DNS A record at the instance **before** reloading Caddy, or the
certificate request fails against a name that does not resolve here yet.

---

## Do NOT use `output: 'standalone'`

Every generic "deploy Next.js to a VPS" guide recommends it. It would break this
app, quietly.

`src/lib/routing.ts` loads the Tier 1 ward polygons with
`path.join(process.cwd(), "public", "data", "chennai-wards.geojson")`, and the read
sits inside a `try/catch` that logs and returns `null`. Standalone deliberately
does not copy `public/`. So with standalone and no manual copy, **Tier 1 vanishes
silently**: every Chennai report falls through to the generic municipal fallback,
nothing throws, and the app looks fine until someone reads the routing tier on a
report.

Deploying the ordinary way costs ~1.5 GB of disk and removes the failure entirely.

---

## The cron

The point of the VPS:

```cron
*/5 * * * * curl -fsS -X POST https://your.domain/api/inbound/poll -H "x-poll-secret: YOUR_SECRET" >/dev/null 2>&1
```

`authorised()` in `src/app/api/inbound/poll/route.ts` was written for exactly this
caller and has never been scheduled anywhere. With it running, SLA breach,
escalation, citizen notifications and inbound authority replies all advance with
**no browser open** — the behaviour the product claims and could not previously
demonstrate unattended.

---

## Verify before repointing Twilio

Run everything below against the VPS while Vercel is still serving live traffic.

```bash
npm run verify:whatsapp -- https://your.domain
```

Then, specifically:

1. **Tier 1 survived the move.** File at a Chennai coordinate and confirm the stored
   `routing.tier` is `1`, not `4`. This is the GeoJSON trap above and it is the
   single most important check.
2. **TLS** — `curl -I https://your.domain` returns a valid certificate.
3. **Mail ports** — `setup.sh` reports 587 and 993; re-check if it flagged either.
4. **Cron** — backdate a report's deadline (`npm run demo:whatsapp`), close every
   browser, wait five minutes, confirm it reached `past_sla` or `escalated`.

Only when all four pass, change the Twilio sandbox webhook to
`https://your.domain/api/whatsapp/inbound`.

---

## Rollback

Leave the Vercel deployment running throughout — it costs nothing and is the
instant fallback.

- Reverting is one field: point the Twilio webhook back at
  `https://nammacity-alpha.vercel.app/api/whatsapp/inbound`.
- Known-good Vercel production deployment: `nammacity-m69s12dkg`.
- Both hosts share one Supabase database, so there is no migration, no sync and no
  divergence — the data is identical whichever is serving.

---

## Operating it

The box tracks `origin/main`. To ship a change: push to `main`, then

```bash
ssh root@65.20.68.161 civicagent-deploy
```

That pulls, installs, builds, restarts and health-checks in one go. It builds
**before** restarting on purpose — `next build` writes to `.next`, and a failed
build must leave the running server alone rather than take the site down. If the
build fails it exits without touching the service.

Everything else:

```bash
ssh root@65.20.68.161 'journalctl -u civicagent -f'   # app logs
ssh root@65.20.68.161 'journalctl -u caddy -f'        # TLS / proxy
ssh root@65.20.68.161 'systemctl restart civicagent'  # after editing .env.local
ssh root@65.20.68.161 'nano /opt/civicagent/.env.local'  # needs ssh -t
```

Editing `.env.local` needs a restart but **not** a rebuild — Next reads it at
runtime.
