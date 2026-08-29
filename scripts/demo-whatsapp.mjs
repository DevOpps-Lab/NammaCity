/**
 * Drives a WhatsApp report through breach -> escalation -> public post ->
 * citizen notification, in one command, so a demo does not require waiting out
 * a real SLA deadline.
 *
 * The compressed demo clock (?demo=1) only exists in the browser, and a report
 * filed over WhatsApp has no browser attached to it — so the honest way to show
 * escalation on stage is to move the deadline into the past and let the REAL
 * sweep run over it. Nothing here fakes a status: `civic_sweep_owner` promotes
 * the report exactly as it would after a genuine breach.
 *
 * Usage:
 *   npm run dev                      # in another terminal
 *   node scripts/demo-whatsapp.mjs   # optionally: <baseUrl>
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and
 * INBOUND_POLL_SECRET in .env.local.
 */

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const BASE = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "");

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

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const POLL_SECRET = process.env.INBOUND_POLL_SECRET;

function die(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

if (!SUPA_URL || !SERVICE_KEY) {
  die("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.");
}
if (!POLL_SECRET) {
  die(
    "Set INBOUND_POLL_SECRET in .env.local — it is what lets this script trigger the sweep\n" +
      "  without a logged-in session. Any random string will do; restart `npm run dev` after."
  );
}

const db = createClient(SUPA_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// The most recent WhatsApp report that has not already been closed.
const { data: report, error } = await db
  .from("reports")
  .select("id, user_id, status, place, category, public_token, sla_deadline")
  .eq("source", "whatsapp")
  .neq("status", "verified_fixed")
  .order("created_at", { ascending: false })
  .limit(1)
  .maybeSingle();

if (error) die(`Could not read the ledger: ${error.message}`);
if (!report) {
  die(
    "No open WhatsApp report found. Send a photo and a location pin to the sandbox number\n" +
      "  first (or run `npm run verify:whatsapp` to file one)."
  );
}

console.log(`\nDemo: ${report.id} — ${report.category} at ${report.place}`);
console.log(`  now: ${report.status}`);

// Past the deadline AND past the +6h escalation gap, so one sweep walks it
// filed -> past_sla -> escalated.
const backdated = Date.now() - 7 * 3600_000;
const { error: updateErr } = await db
  .from("reports")
  .update({ sla_deadline: backdated })
  .eq("user_id", report.user_id)
  .eq("id", report.id);
if (updateErr) die(`Could not backdate the deadline: ${updateErr.message}`);
console.log(`  deadline moved to ${new Date(backdated).toLocaleString("en-IN")} (7h ago)`);

// The real sweep, through the endpoint a cron would use.
const res = await fetch(`${BASE}/api/inbound/poll`, {
  method: "POST",
  headers: { "x-poll-secret": POLL_SECRET },
});
if (res.status === 401) die("The poll endpoint rejected the secret. Restart `npm run dev`?");
const body = await res.json().catch(() => null);
console.log(`  swept: ${JSON.stringify(body?.whatsapp ?? null)}`);

const { data: after } = await db
  .from("reports")
  .select("status")
  .eq("user_id", report.user_id)
  .eq("id", report.id)
  .maybeSingle();

const { data: posts } = await db
  .from("public_posts")
  .select("kind, source, body")
  .eq("report_id", report.id);

const { data: notes } = await db
  .from("whatsapp_notifications")
  .select("kind, delivered, delivery_error")
  .eq("report_owner", report.user_id)
  .eq("report_id", report.id);

console.log(`\n  status      → ${after?.status ?? "unknown"}`);
console.log(`  public post → ${posts?.length ? posts.map((p) => `${p.kind}/${p.source}`).join(", ") : "none"}`);

if (!notes) {
  console.log(`  notified    → table missing (apply supabase/migrations/0011_whatsapp_notify.sql)`);
} else if (!notes.length) {
  console.log(`  notified    → none (no phone recorded for this report)`);
} else {
  for (const n of notes) {
    console.log(
      `  notified    → ${n.kind}: ${n.delivered ? "delivered" : `NOT delivered (${n.delivery_error ?? "pending"})`}`
    );
  }
  console.log(
    `                (63016 = outside WhatsApp's 24h window — expected unless you messaged the bot just now)`
  );
}

if (report.public_token) {
  console.log(`\n  Track link  → ${BASE}/track/${report.public_token}`);
  console.log(`  Open it and send an after-photo to close the report.\n`);
}
