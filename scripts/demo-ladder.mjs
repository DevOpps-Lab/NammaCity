/**
 * Stages the escalation ladder so it can be demonstrated live.
 *
 * The ladder fires three days after a report escalates, which is correct
 * behaviour and impossible to show on stage. This puts one report into exactly
 * the state the ladder is waiting for — escalated, four days ago, no RTI filed
 * — so clicking "Execute Workflow" in n8n makes all five nodes run for real.
 *
 * Nothing is faked. The report genuinely reaches `escalated` and the RTI is
 * genuinely composed and sent by the real endpoint; only the clock is moved.
 *
 * Usage:
 *   npm run demo:ladder
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env.local.
 */

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const DAYS_ESCALATED = 4; // the endpoint requires >= 3

function loadEnv() {
  const file = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
}
loadEnv();

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) {
  console.error("\n✗ Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local\n");
  process.exit(1);
}
const db = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const now = Date.now();
const escalatedAt = now - DAYS_ESCALATED * 86_400_000;

// --------------------------------------------------------------- pick a report
// Prefer one the presenter already filed — a real photo and real routing demo
// far better than a synthetic row. Fall back to creating one so the script
// still works against an empty ledger.
const { data: existing } = await db
  .from("reports")
  .select("id, user_id, place, category, status, routing")
  .neq("status", "verified_fixed")
  // NOT a simulated row. /api/escalation/candidates filters is_seed = false,
  // deliberately, so that generated data can never trigger a real RTI. Without
  // the same filter here this script happily stages a SIM- report, reports
  // success, and the workflow then finds nothing due: the two green nodes and
  // two grey ones look like a broken integration when the staging was the
  // problem. Only reachable once the real ledger is empty, which is exactly
  // the state a demo starts from.
  .eq("is_seed", false)
  .order("created_at", { ascending: false })
  .limit(1)
  .maybeSingle();

let report = existing;

if (!report) {
  console.log("No report found — creating one to escalate.");

  const { data: profile } = await db.from("profiles").select("id").limit(1).maybeSingle();
  if (!profile?.id) {
    console.error("\n✗ No user account exists yet. Sign up in the app first.\n");
    process.exit(1);
  }

  const { data: id, error: idErr } = await db.rpc("next_report_id");
  if (idErr) {
    console.error(`\n✗ Could not mint a report id: ${idErr.message}\n`);
    process.exit(1);
  }

  // Tier 4 routing: an unverified general municipal body, which is what
  // composeRti addresses. Matches what the resolver produces outside the
  // Chennai ward polygons.
  const routing = {
    tier: 4,
    confidence: "low",
    method: "Staged for the escalation-ladder demo — unverified general municipal body.",
    cityName: "Thirumazhisai",
    authorities: [
      {
        id: "fallback-municipal",
        name: "Thirumazhisai — Municipal Body (General Complaints)",
        email: "commissioner@localbody.gov.in",
        verified: false,
        source: "Deterministic fallback — no verified registry covers this location",
        slaHours: 72,
        slaSource: "Default 72h — no published charter located for this location",
      },
    ],
  };

  const createdAt = now - (DAYS_ESCALATED + 3) * 86_400_000;
  const { error: insErr } = await db.from("reports").insert({
    id,
    user_id: profile.id,
    lat: 13.0543,
    lng: 80.076,
    place: "Varadarajapuram, Thirumazhisai",
    category: "pothole",
    category_source: "model",
    category_confidence: 0.91,
    // The column is constrained to ('small','medium','large') — minor/moderate/
    // severe is the LLM's vocabulary, mapped through toSeverity() before it
    // ever reaches the database.
    severity: "large",
    detection_confidence: 0.91,
    photo_url: "",
    status: "escalated",
    routing,
    created_at: createdAt,
    sla_deadline: createdAt + 72 * 3_600_000,
    filed_to: ["Thirumazhisai — Municipal Body (General Complaints)"],
    supporters: 0,
    is_seed: false,
  });
  if (insErr) {
    console.error(`\n✗ Could not create the report: ${insErr.message}\n`);
    process.exit(1);
  }
  report = { id, user_id: profile.id, place: "Varadarajapuram, Thirumazhisai", category: "pothole" };
}

// ------------------------------------------------------------------- escalate
const { error: updErr } = await db
  .from("reports")
  .update({ status: "escalated" })
  .eq("user_id", report.user_id)
  .eq("id", report.id);
if (updErr) {
  console.error(`\n✗ Could not escalate: ${updErr.message}\n`);
  process.exit(1);
}

// The endpoint dates the rung from the timeline, not the SLA deadline — a
// transfer can move the deadline after the fact, so the timeline is the record.
await db
  .from("timeline_events")
  .delete()
  .eq("user_id", report.user_id)
  .eq("report_id", report.id)
  .eq("kind", "escalated");

await db.from("timeline_events").insert({
  report_id: report.id,
  user_id: report.user_id,
  at: escalatedAt,
  kind: "escalated",
  detail: "Published to the public ledger — authority missed its own published deadline",
});

// Any earlier RTI would make this report ineligible, which is the idempotence
// working. Clear it so the demo can run more than once.
const { count: cleared } = await db
  .from("outbox_items")
  .delete({ count: "exact" })
  .eq("user_id", report.user_id)
  .eq("report_id", report.id)
  .eq("kind", "rti");

await db
  .from("timeline_events")
  .delete()
  .eq("user_id", report.user_id)
  .eq("report_id", report.id)
  .eq("kind", "rti");

console.log(`
Staged for the escalation ladder
────────────────────────────────
  report    ${report.id} — ${report.category} at ${report.place}
  status    escalated, ${DAYS_ESCALATED} days ago
  RTI       ${cleared ? `${cleared} previous RTI cleared, ` : ""}none on file

Next:
  1. Open the "CivicAgent — Escalation ladder" workflow in n8n
  2. Click Execute Workflow
  3. All five nodes go green; the last reads
     "RTI filed — statutory 30-day clock started"

The RTI goes to DEMO_AUTHORITY_EMAIL, never a real Public Information Officer.
Re-run this script to stage it again.
`);
