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

// 4b. THE REGRESSION THAT MATTERED: a location outside the Chennai ward
// polygons. This refused in production with "no verified contact for the
// responsible agency ... we won't file blind", while the same photo filed fine
// in the app, because the webhook only ran Tiers 1-2. It must now reach the
// LLM (tier 3) or generic-municipal (tier 4) fallback and file.
console.log("\nNon-Chennai location (Bengaluru) — the reported bug");
let bengaluruToken = null;
{
  const OTHER = "+919000000002";
  await post({
    From: `whatsapp:${OTHER}`,
    Body: "overflowing bin",
    NumMedia: "1",
    MediaUrl0: `${BASE}/icons/icon-192.png`,
    MediaContentType0: "image/png",
  });
  const filed = await post({
    From: `whatsapp:${OTHER}`,
    // MG Road, Bengaluru — far outside any Chennai ward polygon.
    Latitude: "12.9757",
    Longitude: "77.6068",
  });
  check(filed.status === 200, `location accepted (${filed.status})`);
  const refused = /won't file blind|no verified contact for the responsible/i.test(filed.text);
  check(!refused, "does NOT refuse with 'we won't file blind'");
  const m = /\/track\/([0-9a-f-]{36})/i.exec(filed.text);
  if (check(Boolean(m), "filed, with a tracking link")) {
    bengaluruToken = m[1];
    check(
      /unconfirmed|unverified/i.test(filed.text),
      "reply says the contact is unverified (tier 3 or 4 honesty)"
    );
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

  // The Bengaluru report: routed via a fallback tier, with an unverified
  // contact, and community-visible so it shows in the Feed and on the Map.
  if (bengaluruToken) {
    const { data: b } = await db
      .from("reports")
      .select("id, user_id, routing, is_seed, filed_to, status")
      .eq("public_token", bengaluruToken)
      .maybeSingle();
    if (check(Boolean(b), "Bengaluru report row exists")) {
      const tier = b.routing?.tier;
      check(tier === 3 || tier === 4, `routed via a fallback tier (got tier ${tier})`);
      const auths = b.routing?.authorities ?? [];
      check(auths.length > 0, `has at least one authority (${auths.length})`);
      check(
        auths.every((a) => a.verified === false),
        "fallback authorities are all marked unverified"
      );
      check(b.is_seed === false, "is_seed false → visible in the community Feed and Map");
      const ob = await countRows("outbox_items", {
        user_id: b.user_id,
        report_id: b.id,
        kind: "complaint",
      });
      check(ob.error === null && ob.count > 0, `complaint composed (${ob.error ?? ob.count})`);
    }
  }
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
  check(/NammaCity/.test(html), "page rendered content");

  const bogus = await fetch(`${BASE}/track/00000000-0000-0000-0000-000000000000`, {
    redirect: "manual",
  });
  check(bogus.status === 404, `unknown token 404s (${bogus.status})`);

  const malformed = await fetch(`${BASE}/track/not-a-uuid`, { redirect: "manual" });
  check(malformed.status === 404, `malformed token 404s (${malformed.status})`);
}

// 7. OUTBOUND NOTIFICATIONS.
//
// The filing reply promises "we'll message you when the agency responds", so
// two things have to be true: the number has to be recorded at filing, and a
// status change has to produce exactly one notification row per (report, kind)
// no matter how many times the sweep runs over it.
//
// Sending itself is not asserted. With sandbox or dummy credentials Twilio
// answers 401, and outside the 24-hour window it answers 63016 — so a delivered
// notification is not something a local run can honestly claim. What IS
// asserted is the part this codebase controls: recorded, addressed, deduped,
// and the failure written down rather than swallowed.
console.log("\nOutbound notifications");
let notifyDb = null;
if (filedToken && SUPA_URL && SERVICE_KEY) {
  notifyDb = createClient(SUPA_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: report } = await notifyDb
    .from("reports")
    .select("id, user_id, status")
    .eq("public_token", filedToken)
    .maybeSingle();

  if (check(Boolean(report), "filed report is still readable")) {
    const { data: target, error: targetErr } = await notifyDb
      .from("whatsapp_notify")
      .select("phone")
      .eq("report_owner", report.user_id)
      .eq("report_id", report.id)
      .maybeSingle();
    if (targetErr) bad(`notify target query failed: ${targetErr.message}`);
    check(target?.phone === PHONE, `notify target recorded the sender (${target?.phone ?? "none"})`);

    // Backdate past the deadline AND past the +6h escalation gap, so one sweep
    // walks it filed -> past_sla -> escalated.
    const { error: backdateErr } = await notifyDb
      .from("reports")
      .update({ sla_deadline: Date.now() - 7 * 3600_000 })
      .eq("user_id", report.user_id)
      .eq("id", report.id);
    if (backdateErr) bad(`could not backdate the deadline: ${backdateErr.message}`);

    // The sweep runs on the inbound webhook path, so filing another report is
    // what drives it. (The other trigger is /api/inbound/poll, which needs a
    // session or INBOUND_POLL_SECRET and so is not exercised here.)
    const nudge = async (phone) => {
      await post({
        From: `whatsapp:${phone}`,
        Body: "sweep nudge",
        NumMedia: "1",
        MediaUrl0: `${BASE}/icons/icon-192.png`,
        MediaContentType0: "image/png",
      });
      await post({ From: `whatsapp:${phone}`, Latitude: "13.0389", Longitude: "80.2492" });
    };
    await nudge("+919000000003");

    const { data: swept } = await notifyDb
      .from("reports")
      .select("status")
      .eq("user_id", report.user_id)
      .eq("id", report.id)
      .maybeSingle();
    check(
      swept?.status === "escalated",
      `overdue report swept to 'escalated' (got ${swept?.status})`
    );

    const notifications = async () => {
      const { data, error } = await notifyDb
        .from("whatsapp_notifications")
        .select("kind, delivered, delivery_error, phone")
        .eq("report_owner", report.user_id)
        .eq("report_id", report.id);
      if (error) {
        bad(`notification query failed: ${error.message}`);
        return [];
      }
      return data ?? [];
    };

    const first = await notifications();
    const escalations = first.filter((n) => n.kind === "escalated");
    if (check(escalations.length === 1, `exactly one 'escalated' notification (${escalations.length})`)) {
      check(escalations[0].phone === PHONE, "notification is addressed to the filer");
      // Delivered or not, it must not be silent about which.
      check(
        escalations[0].delivered === true || Boolean(escalations[0].delivery_error),
        `outcome recorded (delivered=${escalations[0].delivered}, error=${escalations[0].delivery_error ?? "none"})`
      );
    }

    // THE IDEMPOTENCE CHECK, which is the one that matters: civic_sweep_owner
    // returns every escalated report on every call, not just new ones, so a
    // second sweep must not produce a second message.
    await nudge("+919000000004");
    const second = await notifications();
    check(
      second.filter((n) => n.kind === "escalated").length === 1,
      `a second sweep did NOT duplicate the notification (${second.filter((n) => n.kind === "escalated").length})`
    );
  }
} else {
  console.log("  - skipped (needs a filed report and Supabase service-role credentials)");
}

// 8. CLOSING A REPORT FROM THE TRACKING LINK.
//
// The gap this closes: a citizen who filed over WhatsApp has no account, and
// every closing path in the app needs one, so their report could never finish.
// The rule enforced here is deliberately STRICTER than the in-app path — a
// token is a bearer credential, not an identity, so the vision check is
// mandatory and there is no manual-confirm fallback.
console.log("\nTrack-link verification endpoint");
if (filedToken) {
  const VERIFY = `${BASE}/api/track/verify`;
  const png = fs.readFileSync(path.join(process.cwd(), "public", "icons", "icon-192.png"));
  const photo = `data:image/png;base64,${png.toString("base64")}`;

  const send = (body) =>
    fetch(VERIFY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
    });

  // Reachable at all — the proxy must not 307 this to /login either.
  const malformed = await send({ token: "not-a-uuid", afterDataUrl: photo });
  check(malformed.status === 400, `malformed token rejected with 400 (${malformed.status})`);
  check(malformed.status !== 307, "not redirected to /login");

  const notAnImage = await send({ token: filedToken, afterDataUrl: "data:text/html;base64,PGI+" });
  check(notAnImage.status === 415, `non-image body rejected with 415 (${notAnImage.status})`);

  // 5MB is the bucket's own ceiling (0002_storage.sql).
  const oversized = await send({
    token: filedToken,
    afterDataUrl: `data:image/jpeg;base64,${"A".repeat(7_000_000)}`,
  });
  check(oversized.status === 413, `oversized photo rejected with 413 (${oversized.status})`);

  const unknown = await send({
    token: "00000000-0000-0000-0000-000000000000",
    afterDataUrl: photo,
  });
  check(unknown.status === 404, `unknown token 404s (${unknown.status})`);

  // A real attempt.
  //
  // This deliberately does NOT assert a fixed verdict. The outcome legitimately
  // depends on the environment: no GEMINI_API_KEY gives `unconfigured`, and
  // with a key the model gets an honest look at the before/after pair and may
  // reasonably close (the fixture sends the same image twice — same place, no
  // defect visible, which is what "repaired" looks like). An earlier version of
  // this script hardcoded "must refuse" and then failed the moment vision
  // started working, which is a test asserting its own assumptions rather than
  // the product's rules.
  //
  // What IS asserted is the invariant that has to hold whichever way it goes:
  // a close is accompanied by a stored photo and a closed report, and a refusal
  // changes nothing at all.
  let closedNow = false;
  const attempt = await send({ token: filedToken, afterDataUrl: photo });
  const body = await attempt.json().catch(() => null);
  if (check(Boolean(body), `attempt returned JSON (${attempt.status})`)) {
    closedNow = body.closed === true;
    check(typeof body.closed === "boolean", `outcome is explicit (closed=${body.closed})`);
    check(
      ["closed", "unconfigured", "vision_error", "wrong_place", "still_present", "already_closed", "rate_limited"].includes(
        body.reason
      ),
      `outcome is machine-readable (reason=${body.reason})`
    );
    check(typeof body.headline === "string" && body.headline.length > 0, "outcome has a headline");
    if (body.reason === "unconfigured") {
      console.log("     note: GEMINI_API_KEY is unset, so closure cannot be exercised end to end");
    }
    if (closedNow) {
      console.log("     note: vision verified the fixture and CLOSED it — the full loop ran");
    }
  }

  // The per-token brake, which matters because this is the most expensive
  // unauthenticated request in the codebase (a Gemini call + a storage write).
  const rapid = await send({ token: filedToken, afterDataUrl: photo });
  check(rapid.status === 429, `a second attempt within the gap is throttled (${rapid.status})`);

  // THE INVARIANT UNDERNEATH ALL OF IT: the database state must agree with what
  // the citizen was told. A report that reported "closed" is closed AND has the
  // verifying photo the DB function refuses to close without; a report told
  // anything else is byte-for-byte untouched.
  if (notifyDb) {
    const { data: after } = await notifyDb
      .from("reports")
      .select("status, after_photo_url")
      .eq("public_token", filedToken)
      .maybeSingle();

    if (closedNow) {
      check(
        after?.status === "verified_fixed",
        `close was persisted (status ${after?.status})`
      );
      check(Boolean(after?.after_photo_url), "the verifying after-photo was stored");
    } else {
      check(
        after?.status !== "verified_fixed",
        `report was NOT closed by a failed check (status ${after?.status})`
      );
      check(!after?.after_photo_url, "no after-photo was stored for a failed check");
    }
  }

  // The page itself must offer the affordance.
  const page = await fetch(`${BASE}/track/${filedToken}`);
  const html = await page.text();
  check(/after-photo/i.test(html), "tracking page offers the after-photo action");
}

console.log(
  failures === 0
    ? `\n✓ ALL CHECKS PASSED\n`
    : `\n✗ ${failures} CHECK(S) FAILED\n`
);
process.exit(failures === 0 ? 0 : 1);
