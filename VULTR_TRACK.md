NammaCity is a citizen-verified civic accountability ledger running entirely on one Vultr instance in Mumbai.

**Why a VPS, not serverless**
- The product claims a missed deadline escalates whether or not anyone is watching. That needs a real cron. A system cron sweeps the ledger every 5 minutes, advancing SLA breach, escalation and citizen notifications with no browser open.
- Mumbai co-locates with our ap-south-1 Postgres, so every query stays in-city and the India data-residency story holds.

**Compute serverless cannot host**
- A Python sidecar runs two YOLO pothole models over dashcam frames at ~150ms/frame, keeping 28MB of weights warm in a persistent process.
- It binds to loopback. ufw allows only 22/80/443, so the inference port is unreachable externally; an authenticated Next route is its only front door.

**Engineering notes**
- We deliberately avoided Next's `standalone` output: it omits `public/`, and our ward routing reads a GeoJSON from there inside a try/catch returning null. Standalone would have silently killed Tier 1 ward resolution with no error.
- Sizing follows the build, not traffic. `node_modules` is ~1.5GB; a 1GB instance is OOM-killed mid-build.
- One command pulls, installs, builds, restarts and health-checks, building before restart so a failed build never takes the site down. Caddy handles TLS.
