#!/usr/bin/env node
/**
 * Generates a simulated city caseload so the /admin console has something to be
 * a console OF.
 *
 *   node scripts/seed-city.mjs            # generate (default 4000)
 *   node scripts/seed-city.mjs --count 800
 *   node scripts/seed-city.mjs --clear    # remove them again
 *
 * WHY THIS EXISTS. The real ledger is 33 reports at 3 distinct locations, 32 of
 * them filed on a single day between 03:00 and 08:00, with nothing ever reaching
 * verified_fixed. Every panel on the console would be one bar. This is not
 * decoration; without it the feature cannot be shown to work.
 *
 * THE THREE RULES IT FOLLOWS, each guarding something real:
 *
 *  1. EVERY ROW IS is_seed = true. That flag is what keeps this out of the
 *     citizen app: `reports_select_community` hides seeded rows from every other
 *     account, and civic_ward_scoreboard() filters them out, so the weekly n8n
 *     digest and every public number are untouched. If this were ever written
 *     false, 4000 rows would flood every resident's Feed and Map. scripts/
 *     verify-admin.mjs asserts it did not.
 *
 *  2. IDS COME FROM A SIM- RANGE AND NEVER FROM next_report_id(). The sequence
 *     is shared with real reports; drawing 4000 from it would push the next real
 *     demo report from CA-4719 to roughly CA-8700. The prefix also makes a
 *     simulated row obvious on sight in the drill-down.
 *
 *  3. inserted_at IS WRITTEN EXPLICITLY. It defaults to now(), so a bulk insert
 *     would stamp all 4000 rows with the same instant and collapse the entire
 *     when-view into a single cell. It is the only server-authoritative clock on
 *     the table and the console's time axis depends on it.
 */

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point } from "@turf/helpers";

// ------------------------------------------------------------------ config
const SIM_EMAIL = "city-simulation@nammacity.local";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const args = process.argv.slice(2);
const CLEAR = args.includes("--clear");
const COUNT = Number(args[args.indexOf("--count") + 1]) || 4000;
const MONTHS = 12;

/** Mirrors authorities.ts. Kept as data so this script needs no TS build step. */
const AUTHORITIES = {
  pothole: [{ name: "GCC Bus Route Roads / Roads Department", sla: 72 }],
  storm_water_drain: [
    { name: "GCC Storm Water Drain Department", sla: 72 },
    { name: "CMWSSB (Chennai Metro Water), Area Engineer", sla: 72 },
  ],
  sewage_overflow: [
    { name: "GCC Storm Water Drain Department", sla: 72 },
    { name: "CMWSSB (Chennai Metro Water), Area Engineer", sla: 72 },
  ],
  garbage: [{ name: "GCC Solid Waste Management", sla: 24 }],
  streetlight: [{ name: "GCC Street Lighting Department", sla: 48 }],
  other: [{ name: "GCC Commissioner's Office (General Complaints)", sla: 72 }],
};

const BASE_MIX = {
  pothole: 0.34,
  garbage: 0.2,
  streetlight: 0.15,
  storm_water_drain: 0.12,
  sewage_overflow: 0.11,
  other: 0.08,
};

/**
 * Chennai's north-east monsoon runs October to December, and drains and sewers
 * are what fail then. Without this the category mix is flat across the year and
 * the seasonal story the console is supposed to reveal is not in the data to be
 * revealed.
 */
function seasonalMix(month) {
  const monsoon = month >= 9 && month <= 11;
  if (!monsoon) return BASE_MIX;
  return {
    pothole: 0.3,
    garbage: 0.14,
    streetlight: 0.1,
    storm_water_drain: 0.26,
    sewage_overflow: 0.16,
    other: 0.04,
  };
}

/** Filing peaks on the way to work and again after getting home. */
const HOUR_WEIGHT = [
  0.2, 0.1, 0.08, 0.08, 0.15, 0.5, 1.4, 2.6, 3.0, 2.4, 1.8, 1.5, 1.4, 1.3, 1.3,
  1.5, 1.9, 2.6, 2.9, 2.4, 1.8, 1.2, 0.7, 0.35,
];
/** Sunday is quieter; nobody is commuting past the pothole. */
const DOW_WEIGHT = [0.62, 1.1, 1.08, 1.05, 1.05, 1.0, 0.8];

// ------------------------------------------------------------------- utils
function env() {
  let raw = "";
  try {
    raw = readFileSync(".env.local", "utf8");
  } catch {
    /* fall through to process.env */
  }
  const map = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) map[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || map.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || map.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      "Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, in .env.local or the environment."
    );
    process.exit(1);
  }
  return { url, key };
}

function pick(weights) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (const [k, w] of Object.entries(weights)) {
    r -= w;
    if (r <= 0) return k;
  }
  return Object.keys(weights)[0];
}

function pickIndex(arr) {
  const total = arr.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < arr.length; i++) {
    r -= arr[i];
    if (r <= 0) return i;
  }
  return 0;
}

// ---------------------------------------------------------------- geometry
function loadWards() {
  const geo = JSON.parse(readFileSync("public/data/chennai-wards.geojson", "utf8"));
  return geo.features
    // Ward_No 0 is an artefact in the source data; routing.ts skips it too.
    .filter((f) => Number(f.properties.Ward_No) > 0)
    .map((f) => {
      let minX = 180, minY = 90, maxX = -180, maxY = -90;
      for (const ring of f.geometry.coordinates) {
        for (const [x, y] of ring) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      return {
        ward: Number(f.properties.Ward_No),
        zoneNo: String(f.properties.Zone_No),
        zoneName: String(f.properties.Zone_Name),
        bbox: [minX, minY, maxX, maxY],
        feature: f,
      };
    });
}

/** Rejection sampling inside the polygon, so pins land on the ward, not its box. */
function pointInWard(w) {
  for (let i = 0; i < 60; i++) {
    const lng = w.bbox[0] + Math.random() * (w.bbox[2] - w.bbox[0]);
    const lat = w.bbox[1] + Math.random() * (w.bbox[3] - w.bbox[1]);
    if (booleanPointInPolygon(point([lng, lat]), w.feature)) return { lat, lng };
  }
  return { lat: (w.bbox[1] + w.bbox[3]) / 2, lng: (w.bbox[0] + w.bbox[2]) / 2 };
}

// ------------------------------------------------------------------- shape
/**
 * A lifecycle, with its event log.
 *
 * The verified share is deliberately modest. Indian civic portals report 93-95%
 * resolution because the accused department closes its own ticket; independently
 * measured, FixMyStreet sits near 34%. Generating a flattering number here would
 * bake in exactly the lie the product exists to expose.
 */
function lifecycle(createdAt, slaHours) {
  const deadline = createdAt + slaHours * HOUR;
  const ev = [
    { kind: "reported", at: createdAt, detail: "Reported by citizen" },
    { kind: "filed", at: createdAt + 2 * 60_000, detail: "Filed to responsible agencies" },
  ];
  const roll = Math.random();

  if (roll < 0.14) return { status: "filed", ev, deadline };

  const ackAt = createdAt + (2 + Math.random() * 30) * HOUR;
  ev.push({ kind: "acknowledged", at: ackAt, detail: "Acknowledged by authority. Clock continues." });

  if (roll < 0.24) return { status: "acknowledged", ev, deadline };

  if (roll < 0.32) {
    ev.push({
      kind: "jurisdiction_transfer",
      at: ackAt + 12 * HOUR,
      detail: "Agency says it belongs to another department. Re-filed, clock not reset.",
    });
    return { status: "transferred", ev, deadline };
  }

  if (roll < 0.56) {
    ev.push({
      kind: "claims_done",
      at: ackAt + (12 + Math.random() * 96) * HOUR,
      detail: "Authority claims resolved. Awaiting citizen verification, not closed.",
    });
    return { status: "claims_done", ev, deadline };
  }

  if (roll < 0.78) {
    const claimAt = ackAt + (12 + Math.random() * 72) * HOUR;
    ev.push({ kind: "claims_done", at: claimAt, detail: "Authority claims resolved." });
    ev.push({
      kind: "verified_fixed",
      at: claimAt + (6 + Math.random() * 96) * HOUR,
      detail: "Verified fixed by a resident's photograph",
    });
    return { status: "verified_fixed", ev, deadline };
  }

  ev.push({
    kind: "past_sla",
    at: deadline,
    detail: "SLA breached, authority missed its own published deadline",
  });
  if (roll < 0.9) return { status: "past_sla", ev, deadline };

  ev.push({ kind: "escalated", at: deadline + 6 * HOUR, detail: "Published to the public ledger" });
  return { status: "escalated", ev, deadline };
}

// -------------------------------------------------------------------- main
const { url, key } = env();
const db = createClient(url, key, { auth: { persistSession: false } });

async function simulationUser() {
  const { data: list } = await db.auth.admin.listUsers({ perPage: 1000 });
  const found = list?.users?.find((u) => u.email === SIM_EMAIL);
  if (found) return found.id;

  const { data, error } = await db.auth.admin.createUser({
    email: SIM_EMAIL,
    email_confirm: true,
    password: `sim-${crypto.randomUUID()}`,
    user_metadata: { display_name: "City simulation" },
  });
  if (error) throw error;
  return data.user.id;
}

async function clear(userId) {
  // Timelines cascade from reports, so one delete is enough. Scoped to the
  // simulation account AND is_seed, so it cannot reach a real report even if
  // the account were somehow reused.
  const { error } = await db.from("reports").delete().eq("user_id", userId).eq("is_seed", true);
  if (error) throw error;
}

async function main() {
  console.log(`\nSimulation account: ${SIM_EMAIL}`);
  const userId = await simulationUser();

  const { count: before } = await db
    .from("reports")
    .select("id", { count: "exact", head: true })
    .eq("is_seed", false);
  console.log(`Real (non-seed) reports before: ${before}`);

  console.log("Clearing any previous simulation…");
  await clear(userId);
  if (CLEAR) {
    const { count: after } = await db
      .from("reports")
      .select("id", { count: "exact", head: true })
      .eq("is_seed", false);
    console.log(`Cleared. Real reports still: ${after}\n`);
    return;
  }

  const wards = loadWards();
  console.log(`Wards loaded: ${wards.length}`);
  console.log(`Generating ${COUNT} reports over ${MONTHS} months…`);

  const now = Date.now();
  const span = MONTHS * 30 * DAY;
  const reports = [];
  const events = [];

  // A handful of locations are reused so the recurrence view has something real
  // to find, including some that were verified fixed and then reported again.
  const hotspots = Array.from({ length: 40 }, () => {
    const w = wards[Math.floor(Math.random() * wards.length)];
    return { w, ...pointInWard(w) };
  });

  for (let i = 0; i < COUNT; i++) {
    // Pick the day first, then push the time of day onto it, so the hour and
    // weekday shapes survive instead of being averaged away.
    const daysAgo = Math.floor(Math.random() * (span / DAY));
    const d = new Date(now - daysAgo * DAY);
    d.setHours(pickIndex(HOUR_WEIGHT), Math.floor(Math.random() * 60), 0, 0);
    if (Math.random() > DOW_WEIGHT[d.getDay()] / 1.1) continue;

    const createdAt = d.getTime();
    const category = pick(seasonalMix(d.getMonth()));

    const useHotspot = Math.random() < 0.18;
    const spot = useHotspot ? hotspots[Math.floor(Math.random() * hotspots.length)] : null;
    const w = spot ? spot.w : wards[Math.floor(Math.random() * wards.length)];
    const pos = spot ? { lat: spot.lat, lng: spot.lng } : pointInWard(w);

    const auth = AUTHORITIES[category];
    const slaHours = Math.min(...auth.map((a) => a.sla));
    const { status, ev, deadline } = lifecycle(createdAt, slaHours);

    const id = `SIM-${String(i + 1).padStart(5, "0")}`;
    const insertedAt = new Date(createdAt).toISOString();

    reports.push({
      id,
      user_id: userId,
      lat: pos.lat,
      lng: pos.lng,
      place: `${w.zoneName.replace(/\b\w/g, (c) => c.toUpperCase())}, Ward ${w.ward}`,
      category,
      severity: ["small", "small", "medium", "medium", "large"][Math.floor(Math.random() * 5)],
      detection_confidence: 0,
      photo_url: "",
      status,
      routing: {
        tier: 1,
        confidence: "high",
        method: `Ward polygon match, GCC open ward dataset (${w.zoneName}, Zone ${w.zoneNo})`,
        ward: w.ward,
        zoneName: w.zoneName,
        zoneNo: w.zoneNo,
        cityName: "Greater Chennai Corporation",
        authorities: [],
      },
      created_at: createdAt,
      sla_deadline: deadline,
      filed_to: auth.map((a) => a.name),
      supporters: Math.random() < 0.25 ? Math.floor(Math.random() * 6) : 0,
      is_seed: true,
      inserted_at: insertedAt,
      category_source: "model",
      category_confidence: 0.7 + Math.random() * 0.3,
      source: Math.random() < 0.2 ? "whatsapp" : "app",
    });

    for (const e of ev) {
      events.push({
        report_id: id,
        user_id: userId,
        at: e.at,
        kind: e.kind,
        detail: e.detail,
        inserted_at: new Date(e.at).toISOString(),
      });
    }
  }

  await insertChunks("reports", reports, 400);
  await insertChunks("timeline_events", events, 800);

  const { count: after } = await db
    .from("reports")
    .select("id", { count: "exact", head: true })
    .eq("is_seed", false);

  console.log(`\nInserted ${reports.length} reports and ${events.length} events.`);
  console.log(`Real (non-seed) reports after: ${after}`);
  console.log(
    before === after
      ? "Containment OK: the real ledger is unchanged.\n"
      : `CONTAINMENT FAILED: real count moved ${before} -> ${after}. Run --clear.\n`
  );
  if (before !== after) process.exit(1);
}

async function insertChunks(table, rows, size) {
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await db.from(table).insert(rows.slice(i, i + size));
    if (error) {
      console.error(`\n${table} insert failed at row ${i}:`, error.message);
      process.exit(1);
    }
    process.stdout.write(`\r  ${table}: ${Math.min(i + size, rows.length)}/${rows.length}`);
  }
  process.stdout.write("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
