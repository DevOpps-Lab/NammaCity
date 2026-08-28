/**
 * Drives the WhatsApp intake webhook end to end without Twilio.
 *
 * This is possible because the webhook's authenticity check is an HMAC keyed on
 * TWILIO_AUTH_TOKEN, which we hold — so a correctly-signed request is
 * indistinguishable from a real one. The whole two-message conversation can be
 * replayed against a local dev server.
 *
 * Usage (the flag is needed to import the TypeScript exif module directly,
 * rather than keeping a second copy of it in JavaScript):
 *   npm run dev            # in another terminal
 *   node --experimental-strip-types scripts/verify-whatsapp.mjs [baseUrl]
 *
 * Reads .env.local for TWILIO_AUTH_TOKEN (to sign), plus
 * NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for the database
 * assertions. Local values may be dummies: the signature only has to agree with
 * the server's, and the media URL points at this same dev server.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { stripJpegMetadata, hasExifSegment, isJpeg } from "../src/lib/exif.ts";

const BASE = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "");
const WEBHOOK = `${BASE}/api/whatsapp/inbound`;
const PHONE = "+919000000001";

// ------------------------------------------------------------------ env
function loadEnv() {
  const file = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, k, raw] = m;
    if (!process.env[k]) process.env[k] = raw.replace(/^"(.*)"$/, "$1");
  }
}
loadEnv();

const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let failures = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => {
  failures++;
  console.error(`  ✗ ${msg}`);
};
function check(cond, msg) {
  if (cond) ok(msg);
  else bad(msg);
  return cond;
}

// --------------------------------------------------------- signed request
/** Twilio's scheme: url + each sorted name+value, HMAC-SHA1, base64. */
function sign(url, params) {
  const names = [...new Set(params.keys())].sort();
  let data = url;
  for (const n of names) for (const v of params.getAll(n)) data += n + v;
  return crypto.createHmac("sha1", AUTH_TOKEN).update(Buffer.from(data, "utf8")).digest("base64");
}

async function post(fields, { signature } = {}) {
  const params = new URLSearchParams(fields);
  const res = await fetch(WEBHOOK, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Twilio-Signature": signature ?? sign(WEBHOOK, params),
    },
    body: params.toString(),
    redirect: "manual",
  });
  return { status: res.status, text: await res.text() };
}

// ------------------------------------------------------------------ tests
console.log(`\nWhatsApp intake verification against ${BASE}\n`);

// 0. Offline unit check of the EXIF stripper.
console.log("EXIF stripper");
{
  // Minimal JPEG: SOI + APP1(Exif) + SOS + EOI.
  const exifPayload = Buffer.concat([
    Buffer.from("Exif\0\0", "ascii"),
    Buffer.alloc(20, 0x11),
  ]);
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1]),
    Buffer.from([((exifPayload.length + 2) >> 8) & 0xff, (exifPayload.length + 2) & 0xff]),
    exifPayload,
  ]);
  const withExif = new Uint8Array(
    Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      app1,
      Buffer.from([0xff, 0xda, 0x00, 0x03, 0x00]),
      Buffer.from([0x12, 0x34, 0x56]),
      Buffer.from([0xff, 0xd9]),
    ])
  );
  check(isJpeg(withExif), "fixture is recognised as JPEG");
  check(hasExifSegment(withExif), "fixture starts with an APP1/Exif segment");
  const cleaned = stripJpegMetadata(withExif);
  check(!hasExifSegment(cleaned), "APP1/Exif segment is gone after stripping");
  check(cleaned.length < withExif.length, "stripped image is smaller");
  check(cleaned[0] === 0xff && cleaned[1] === 0xd8, "still starts with SOI");
  check(
    cleaned[cleaned.length - 2] === 0xff && cleaned[cleaned.length - 1] === 0xd9,
    "still ends with EOI"
  );
  // Non-JPEG must pass through untouched rather than be corrupted.
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  check(stripJpegMetadata(png) === png, "non-JPEG input is returned untouched");
}

// 1. Reachability: the proxy must NOT redirect this route.
console.log("\nReachability (the bug the old stub had)");
{
  const res = await fetch(WEBHOOK, { method: "GET", redirect: "manual" });
  check(res.status !== 307 && res.status !== 302, `GET not redirected to /login (${res.status})`);
  const unsigned = await post({ From: `whatsapp:${PHONE}`, Body: "hi" }, { signature: "nope" });
  check(unsigned.status === 403, `unsigned POST rejected with 403 (got ${unsigned.status})`);
  check(!unsigned.text.includes("<html"), "rejection is not an HTML login page");
}

// 2. Greeting.
console.log("\nGreeting");
{
  const r = await post({ From: `whatsapp:${PHONE}`, Body: "hello" });
  check(r.status === 200, `signed text POST accepted (${r.status})`);
  check(r.text.includes("<Response>"), "reply is TwiML");
  check(!r.text.includes("\\n"), "reply has real newlines, not literal backslash-n");
}

// 3. Location before photo must guide, not crash.
console.log("\nLocation before photo");
{
  const r = await post({
    From: `whatsapp:${PHONE}`,
    Latitude: "13.0389",
    Longitude: "80.2492",
  });
  check(r.status === 200, `accepted (${r.status})`);
  check(/photo/i.test(r.text), "asks for a photo first");
}

// 4. The real conversation: photo, then location.
console.log("\nFull conversation");
let filedToken = null;
{
  // MediaUrl0 is fetched by the webhook with Basic auth; a local static file
  // ignores the header and serves the bytes, which is all we need.
  const photo = await post({
    From: `whatsapp:${PHONE}`,
    Body: "big pothole near the bus stop",
    NumMedia: "1",
    MediaUrl0: `${BASE}/icons/icon-192.png`,
    MediaContentType0: "image/png",
  });
  check(photo.status === 200, `photo accepted (${photo.status})`);
  const asksLocation = /location/i.test(photo.text);
  check(asksLocation, "reply asks for a location pin");
  if (!asksLocation) console.error(`     reply was: ${photo.text.slice(0, 300)}`);

  const filed = await post({
    From: `whatsapp:${PHONE}`,
    Latitude: "13.0389",
    Longitude: "80.2492",
  });
  check(filed.status === 200, `location accepted (${filed.status})`);
  const m = /\/track\/([0-9a-f-]{36})/i.exec(filed.text);
  if (check(Boolean(m), "reply contains a /track/<uuid> link")) {
    filedToken = m[1];
    check(/CA-\d+/.test(filed.text), "reply names a sequence-minted report id (CA-…)");
  } else {
    console.error(`     reply was: ${filed.text.slice(0, 400)}`);
  }
}

// 5. What actually landed in the database.
console.log("\nPersisted state");
if (filedToken && SUPA_URL && SERVICE_KEY) {
  const db = createClient(SUPA_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  /**
   * Counts rows, and treats a query ERROR as a failure rather than as zero.
   * An earlier version destructured only `count`, so a failing query looked
   * identical to a missing row — it reported the complaint outbox row as
   * absent when it was actually there.
   */
  const countRows = async (table, filters) => {
    let q = db.from(table).select("*", { count: "exact", head: true });
    for (const [col, val] of Object.entries(filters)) q = q.eq(col, val);
    const { count, error } = await q;
    if (error) return { count: null, error: error.message };
    return { count: count ?? 0, error: null };
  };

  const { data: report, error: reportErr } = await db
    .from("reports")
    .select("id, user_id, source, is_seed, status, category, lat, lng, filed_to, photo_url")
    .eq("public_token", filedToken)
    .maybeSingle();
  if (reportErr) bad(`report query failed: ${reportErr.message}`);

  if (check(Boolean(report), "report row exists for that token")) {
    check(report.source === "whatsapp", `source is 'whatsapp' (got ${report.source})`);
    check(report.is_seed === false, "is_seed false, so it shows on the community map");
    check(report.status === "filed", `status is 'filed' (got ${report.status})`);
    check(Boolean(report.photo_url), "photo_url is set");

    const timeline = await countRows("timeline_events", {
      user_id: report.user_id,
      report_id: report.id,
    });
    check(
      timeline.error === null && timeline.count > 0,
      `timeline rows written (${timeline.error ?? timeline.count})`
    );

    const outbox = await countRows("outbox_items", {
      user_id: report.user_id,
      report_id: report.id,
      kind: "complaint",
    });
    check(
      outbox.error === null && outbox.count > 0,
      `complaint composed in the outbox (${outbox.error ?? outbox.count})`
    );
  }

  const leftover = await countRows("whatsapp_sessions", {
    phone_hash: crypto.createHash("sha256").update(PHONE).digest("hex"),
  });
  check(
    leftover.error === null && leftover.count === 0,
    `pending session cleared after filing (${leftover.error ?? leftover.count})`
  );
} else if (!SUPA_URL || !SERVICE_KEY) {
  console.log("  - skipped (no Supabase service-role credentials in .env.local)");
}

// 6. The public tracking page.
console.log("\nPublic tracking page");
if (filedToken) {
  const good = await fetch(`${BASE}/track/${filedToken}`, { redirect: "manual" });
  check(good.status === 200, `renders unauthenticated (${good.status})`);
  const html = await good.text();
  check(!/\/login/.test(new URL(good.url).pathname), "was not redirected to /login");
  check(/CivicAgent/.test(html), "page rendered content");

  const bogus = await fetch(`${BASE}/track/00000000-0000-0000-0000-000000000000`, {
    redirect: "manual",
  });
  check(bogus.status === 404, `unknown token 404s (${bogus.status})`);

  const malformed = await fetch(`${BASE}/track/not-a-uuid`, { redirect: "manual" });
  check(malformed.status === 404, `malformed token 404s (${malformed.status})`);
}

console.log(
  failures === 0
    ? `\n✓ ALL CHECKS PASSED\n`
    : `\n✗ ${failures} CHECK(S) FAILED\n`
);
process.exit(failures === 0 ? 0 : 1);
