#!/usr/bin/env node
/**
 * Verifies the dashcam detection sidecar on the VPS.
 *
 *   npm run verify:detector
 *   npm run verify:detector -- root@1.2.3.4 https://namma.duckdns.org
 *
 * Split by where each fact is observable. The public half runs from here: the
 * inference port must NOT be reachable over the internet, and the route in
 * front of it must demand a session. The private half runs over ssh, because
 * the sidecar binds to loopback by design and that is the whole security
 * argument — if this script could reach it directly, the deployment would be
 * wrong.
 *
 * The last check STOPS the detector on purpose, confirms the app survives
 * without it, and starts it again. That failure mode is the one that matters:
 * a dashcam which breaks because a Python service restarted would be worse
 * than the in-browser detector we already had.
 */

import { execFileSync } from "node:child_process";

const HOST = process.argv[2] ?? "root@65.20.68.161";
const SITE = (process.argv[3] ?? "https://namma.duckdns.org").replace(/\/$/, "");
const FRAME = "/tmp/frame_phone.jpg";

let failures = 0;

function ok(label, detail = "") {
  console.log(`  \x1b[32mPASS\x1b[0m  ${label}${detail ? `  ${detail}` : ""}`);
}
function bad(label, detail = "") {
  failures++;
  console.log(`  \x1b[31mFAIL\x1b[0m  ${label}${detail ? `  ${detail}` : ""}`);
}
/**
 * HTTP status without `-o /dev/null` — Windows curl.exe cannot open that path
 * and exits 23, which reads like a network failure rather than a path problem.
 * The status is fenced onto its own line and the body ignored.
 */
function httpCode(args) {
  const full = ["-s", "-w", "\n<<%{http_code}>>", ...args];
  let out = "";
  try {
    out = execFileSync("curl", full, { encoding: "utf8", timeout: 30_000 });
  } catch (err) {
    out = err.stdout ?? "";
  }
  return out.match(/<<(\d{3})>>/)?.[1] ?? "000";
}

function ssh(cmd) {
  return execFileSync("ssh", ["-o", "BatchMode=yes", HOST, cmd], {
    encoding: "utf8",
    timeout: 120_000,
  }).trim();
}

console.log(`\nDetector verification — ${HOST}\n`);

// ---------------------------------------------------------------- public half
console.log("From the public internet");

for (const port of [8001, 8002]) {
  const host = HOST.split("@").pop();
  try {
    execFileSync("curl", ["-s", "--max-time", "6", `http://${host}:${port}/health`], {
      encoding: "utf8",
    });
    bad(`port ${port} is not publicly reachable`, "IT ANSWERED — check ufw");
  } catch {
    ok(`port ${port} is not publicly reachable`);
  }
}

// `/api/dashcam/` is absent from PUBLIC_PATHS in src/proxy.ts, which IS the
// sidecar's authentication. If this ever returns 200, the sidecar is open.
for (const method of ["GET", "POST"]) {
  const code = httpCode(["-X", method, `${SITE}/api/dashcam/detect`]);
  if (code === "307" || code === "302") ok(`${method} /api/dashcam/detect needs a session`, `HTTP ${code}`);
  else bad(`${method} /api/dashcam/detect needs a session`, `HTTP ${code}, expected 307`);
}

// --------------------------------------------------------------- private half
console.log("\nOn the box");

let port = "8002";
try {
  port =
    ssh("sed -n 's/^Environment=DETECTOR_PORT=//p' /etc/systemd/system/civicagent-detector.service") ||
    "8001";
} catch {
  /* fall through to the health check, which will report properly */
}

try {
  const health = JSON.parse(ssh(`curl -fsS --max-time 20 http://127.0.0.1:${port}/health`));
  const models = health.models ?? [];
  if (models.length === 2) ok("both models loaded", models.join(" + "));
  else bad("both models loaded", `got ${models.length}: ${models.join(", ") || "none"}`);
} catch (err) {
  bad("sidecar answers /health", err.message.split("\n")[0]);
}

// The app must be told where the sidecar moved to, or it silently uses the
// 8001 default and proxies to whatever else is sitting there.
try {
  const url = ssh("grep '^DETECTOR_URL=' /opt/civicagent/.env.local || true");
  if (url.includes(`:${port}`)) ok("app points at the sidecar", url.split("=")[1]);
  else bad("app points at the sidecar", url || "DETECTOR_URL not set");
} catch (err) {
  bad("app points at the sidecar", err.message.split("\n")[0]);
}

try {
  const hasFrame = ssh(`test -f ${FRAME} && echo yes || echo no`);
  if (hasFrame === "yes") {
    const raw = ssh(`curl -fsS --max-time 60 -F "frame=@${FRAME}" http://127.0.0.1:${port}/infer`);
    const body = JSON.parse(raw);
    const labels = new Set((body.detections ?? []).map((d) => d.classLabel));
    ok("inference on a real frame", `${body.count} boxes in ${body.ms}ms`);

    // `best.pt` was trained without class names and reports its class as "0".
    if (labels.has("0")) bad("class aliasing", 'a box came back labelled "0"');
    else ok("class aliasing", labels.size ? [...labels].join(", ") : "no boxes to label");

    // Steady state was ~150ms. Well past that means the box is loaded or the
    // warmup regressed; either way the number should be said out loud, not
    // rounded off in a pitch.
    if (body.ms > 800) bad("latency is demo-usable", `${body.ms}ms per frame`);
    else ok("latency is demo-usable", `${body.ms}ms per frame`);
  } else {
    console.log(`  \x1b[33mSKIP\x1b[0m  inference on a real frame  (no ${FRAME} on the box)`);
  }
} catch (err) {
  bad("inference on a real frame", err.message.split("\n")[0]);
}

// ------------------------------------------------------------------- fallback
console.log("\nWith the detector deliberately stopped");

try {
  ssh("systemctl stop civicagent-detector");

  const refused = ssh(
    `curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:${port}/health || true`
  );
  if (refused === "000") ok("sidecar is genuinely down");
  else bad("sidecar is genuinely down", `something still answers: HTTP ${refused}`);

  // The app must not care. If this stops answering, the sidecar became a hard
  // dependency, which is exactly what the 503-and-fall-back design avoids.
  const site = httpCode(["--max-time", "20", `${SITE}/login`]);
  if (site === "200") ok("app still serves with no detector", `HTTP ${site}`);
  else bad("app still serves with no detector", `HTTP ${site}`);

  const code = httpCode([`${SITE}/api/dashcam/detect`]);
  if (code === "307") ok("route still gated, not 500", `HTTP ${code}`);
  else bad("route still gated, not 500", `HTTP ${code}`);
} finally {
  ssh("systemctl start civicagent-detector");
  // The warmup runs at import, so give it room before declaring it back.
  ssh("sleep 25");
  const back = ssh(
    `curl -s -o /dev/null -w '%{http_code}' --max-time 30 http://127.0.0.1:${port}/health || true`
  );
  if (back === "200") ok("detector restarted cleanly");
  else bad("detector restarted cleanly", `HTTP ${back} — journalctl -u civicagent-detector -n 40`);
}

console.log(
  failures === 0
    ? "\n\x1b[32mAll detector checks passed.\x1b[0m\n"
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`
);
process.exit(failures === 0 ? 0 : 1);
