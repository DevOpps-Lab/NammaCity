#!/usr/bin/env bash
#
# One-time provisioning for a fresh Ubuntu 24.04 Vultr instance.
#
#   ssh root@<ip> 'bash -s' < deploy/setup.sh
#
# Idempotent: safe to re-run. It installs the runtime and the reverse proxy but
# deliberately does NOT clone the repo or write secrets — see deploy/README.md
# for those steps, which need your judgement rather than a script.
set -euo pipefail

APP_USER="civicagent"
APP_DIR="/opt/civicagent"
NODE_MAJOR="22"   # matches the development machine (v22.17.0)

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

# --------------------------------------------------------------------- swap
# The build, not the traffic, is what sizes this box: a full `next build` runs a
# TypeScript pass over a tree that includes TensorFlow.js, ONNX Runtime and
# MapLibre. On 2 GB it is tight and on 1 GB it is killed outright. Swap turns a
# possible OOM into merely a slow build, and costs nothing on an idle server.
if [ ! -f /swapfile ]; then
  log "Creating 2 GB swap"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
else
  log "Swap already present, skipping"
fi

# --------------------------------------------------------------- base packages
log "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git ufw

# ---------------------------------------------------------------------- node
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2- | cut -d. -f1)" != "$NODE_MAJOR" ]; then
  log "Installing Node ${NODE_MAJOR} LTS"
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
else
  log "Node $(node -v) already installed"
fi

# --------------------------------------------------------------------- caddy
# Caddy rather than nginx purely because it obtains and renews Let's Encrypt
# certificates without configuration. Twilio will not POST a webhook over plain
# http, so TLS is a hard requirement here, not a nicety.
if ! command -v caddy >/dev/null 2>&1; then
  log "Installing Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
else
  log "Caddy already installed"
fi

# ------------------------------------------------------------------- app user
# The app runs as an unprivileged user. Next binds to 127.0.0.1 only (see the
# systemd unit) so nothing but Caddy can reach it.
if ! id "$APP_USER" >/dev/null 2>&1; then
  log "Creating ${APP_USER} user"
  useradd --system --create-home --home-dir "$APP_DIR" --shell /bin/bash "$APP_USER"
else
  log "User ${APP_USER} already exists"
fi
mkdir -p "$APP_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ------------------------------------------------------------------ firewall
# Belt and braces alongside the Vultr Cloud Firewall. Port 3000 is deliberately
# NOT opened — it is reachable only from localhost, via Caddy.
log "Configuring ufw"
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp   >/dev/null
ufw allow 80/tcp   >/dev/null
ufw allow 443/tcp  >/dev/null
ufw --force enable >/dev/null

# -------------------------------------------------------------- port sanity
# nodemailer sends on 587 and imapflow reads on 993. Vultr blocks 25 on new
# accounts but not these — worth proving now, because a blocked port fails in a
# way that looks exactly like a bug in the correspondence code.
log "Checking outbound mail ports"
for port in 587 993; do
  if timeout 5 bash -c "cat < /dev/null > /dev/tcp/smtp.gmail.com/${port}" 2>/dev/null; then
    echo "  port ${port}: reachable"
  else
    echo "  port ${port}: BLOCKED — correspondence will fail, open a Vultr support ticket"
  fi
done

log "Base setup complete"
cat <<'EOF'

Next, from deploy/README.md:
  1. clone the repo into /opt/civicagent as the civicagent user
  2. write .env.local (three values differ from Vercel)
  3. npm ci && npm run build
  4. install the systemd unit and the Caddyfile
  5. add the cron entry — this is the reason for the whole exercise

EOF
