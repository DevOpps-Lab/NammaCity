#!/usr/bin/env bash
#
# Provisions the pothole detection sidecar on the VPS.
#
#   ssh root@<ip> 'bash -s' < deploy/setup-detector.sh
#
# Idempotent. Installs a venv under detector/, pulls the Python deps, and
# reports whether the model weights are present — it cannot fetch those itself,
# because they are deliberately not in git (28 MB for an optional feature).
#
# Copy them separately, from the machine that has them:
#   scp pothole_yolov8n.pt best.pt root@<ip>:/opt/civicagent/detector/models/
set -euo pipefail

APP_DIR="/opt/civicagent"
DET_DIR="${APP_DIR}/detector"
APP_USER="civicagent"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

[ -d "$DET_DIR" ] || { echo "No ${DET_DIR} — deploy the app first."; exit 1; }

log "Installing python3-venv"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3-venv python3-pip libgl1 libglib2.0-0

# opencv-python-headless still needs libgl1/libglib on a bare server image;
# without them the import fails with a linker error that reads like a Python bug.

log "Creating the virtualenv"
if [ ! -x "${DET_DIR}/venv/bin/python" ]; then
  sudo -u "$APP_USER" python3 -m venv "${DET_DIR}/venv"
fi

log "Installing dependencies (torch is large — this takes a few minutes)"
sudo -u "$APP_USER" "${DET_DIR}/venv/bin/pip" install -q --upgrade pip
sudo -u "$APP_USER" "${DET_DIR}/venv/bin/pip" install -q -r "${DET_DIR}/requirements.txt"

log "Checking for model weights"
mkdir -p "${DET_DIR}/models"
chown -R "$APP_USER:$APP_USER" "${DET_DIR}"
missing=0
for m in pothole_yolov8n.pt best.pt; do
  if [ -f "${DET_DIR}/models/${m}" ]; then
    printf '  %-22s %s\n' "$m" "$(du -h "${DET_DIR}/models/${m}" | cut -f1)"
  else
    printf '  %-22s MISSING\n' "$m"
    missing=1
  fi
done

if [ "$missing" = "1" ]; then
  cat <<'MSG'

  Weights are not in git. Copy them from the machine that has them:

    scp pothole_yolov8n.pt best.pt root@<ip>:/opt/civicagent/detector/models/
    ssh root@<ip> 'chown -R civicagent:civicagent /opt/civicagent/detector/models'

  Then install the service:

    cp /opt/civicagent/deploy/civicagent-detector.service /etc/systemd/system/
    systemctl daemon-reload && systemctl enable --now civicagent-detector

MSG
  exit 0
fi

log "Installing the service"
cp "${APP_DIR}/deploy/civicagent-detector.service" /etc/systemd/system/
systemctl daemon-reload
systemctl restart civicagent-detector
systemctl enable -q civicagent-detector
sleep 10

# Read the port back out of the unit rather than hardcoding it here, so the two
# cannot drift. Anything else already listening is left alone — move the
# sidecar, do not evict a service somebody else is running.
PORT="$(sed -n 's/^Environment=DETECTOR_PORT=//p' /etc/systemd/system/civicagent-detector.service)"
PORT="${PORT:-8001}"

log "Health (port ${PORT})"
curl -fsS --max-time 30 "http://127.0.0.1:${PORT}/health" || {
  echo "  not healthy — journalctl -u civicagent-detector -n 40"
  exit 1
}
echo ""

if ! grep -q "^DETECTOR_URL=" "${APP_DIR}/.env.local" 2>/dev/null; then
  log "Pointing the app at the sidecar"
  echo "DETECTOR_URL=http://127.0.0.1:${PORT}" >> "${APP_DIR}/.env.local"
  systemctl restart civicagent
  echo "  added DETECTOR_URL and restarted civicagent"
fi
echo ""
log "Detector ready"
