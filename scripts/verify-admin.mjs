#!/usr/bin/env node
/**
 * Verifies the government console: that it is closed, and that the simulated
 * caseload stayed where it was put.
 *
 *   npm run verify:admin
 *   npm run verify:admin -- https://namma.duckdns.org
 *
 * Split by what each check can actually prove.
 *
 * STATIC checks read the migration and assert the analytics functions cannot
 * return a citizen's identity. That is a source-level guard on purpose: the day
 * someone adds user_id to the drill-down to make a join easier, this fails
 * before it ships, and no amount of runtime testing against today's data would
 * have caught it.
 *
 * LIVE checks prove the gate is shut and the containment held. They cannot prove
 * the console WORKS for a government account, because that needs a real gov
 * session and this script has no password. Point a browser at /admin for that
 * half; the honest boundary of an automated check is worth stating rather than
 * papering over with a test that only appears to cover it.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SITE = (process.argv[2] ?? "https://namma.duckdns.org").replace(/\/$/, "");

let failures = 0;
const ok = (l, d = "") => console.log(`  \x1b[32mPASS\x1b[0m  ${l}${d ? `  ${d}` : ""}`);
const bad = (l, d = "") => {
  failures++;
  console.log(`  \x1b[31mFAIL\x1b[0m  ${l}${d ? `  ${d}` : ""}`);
};
const check = (c, l, d = "") => (c ? ok(l, d) : bad(l, d));

/** Windows curl.exe cannot open /dev/null and exits 23, which reads as a network fault. */
function httpCode(args) {
  let out = "";
  try {
    out = execFileSync("curl", ["-s", "-w", "\n<<%{http_code}>>", ...args], {
      encoding: "utf8",
      timeout: 30_000,
    });
  } catch (e) {
    out = e.stdout ?? "";
  }
  return { code: out.match(/<<(\d{3})>>/)?.[1] ?? "000", body: out };
}

console.log("\nCity console\n");

// ------------------------------------------------------------------ static
console.log("Source guarantees");

const sql = readFileSync("supabase/migrations/0017_admin_analytics.sql", "utf8");

// Every `returns table (...)` block in the analytics migration, checked for
// anything that identifies the person who filed the report.
const returnBlocks = [...sql.matchAll(/returns table \(([\s\S]*?)\)\s*language/g)].map((m) => m[1]);
check(returnBlocks.length >= 6, "every analytics function was found", `${returnBlocks.length} functions`);

const leaky = returnBlocks.filter((b) => /\b(user_id|phone|email)\b/.test(b));
check(
  leaky.length === 0,
  "no analytics function returns user_id, phone or email",
  leaky.length ? `${leaky.length} leaking` : ""
);

// The authorisation check is the only thing standing between a citizen and the
// whole city's data, so assert it is present once per function rather than
// trusting it was not deleted during a refactor.
const guards = (sql.match(/if not public\.civic_is_gov\(\) then/g) ?? []).length;
check(guards >= 6, "every function opens with a civic_is_gov() check", `${guards} guards`);

const definer = (sql.match(/security definer/g) ?? []).length;
check(definer >= 6, "every function is security definer", `${definer}`);

// created_at is demo-clock corrupted; inserted_at is the server clock.
check(
  !/\br\.created_at\b/.test(sql),
  "no analytics function filters or buckets on created_at",
  "time comes from inserted_at"
);

// The generator must never write a real-looking row.
const gen = readFileSync("scripts/seed-city.mjs", "utf8");
check(/is_seed: true/.test(gen) && !/is_seed: false/.test(gen), "the generator only ever writes is_seed: true");
check(!/next_report_id/.test(gen), "the generator never draws from the shared report id sequence");
check(/inserted_at:/.test(gen), "the generator writes inserted_at explicitly");

// -------------------------------------------------------------------- live
console.log("\nFrom the public internet");

for (const path of ["/admin"]) {
  const { code, body } = httpCode([`${SITE}${path}`]);
  const redirected = code === "307" || code === "302";
  check(redirected, `${path} is not public`, `HTTP ${code}`);
  check(!/City console/.test(body), `${path} renders nothing to an anonymous visitor`);
}

// The anon key is in the client bundle, so this is the cheapest attack surface:
// call the analytics functions with no session at all.
const env = readFileSync(".env.local", "utf8");
const supaUrl = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.+)/)?.[1]?.trim();
const anonKey = env.match(/NEXT_PUBLIC_SUPABASE_ANON_KEY=(.+)/)?.[1]?.trim();

if (supaUrl && anonKey) {
  const fns = [
    "civic_admin_funnel",
    "civic_admin_wards",
    "civic_admin_when",
    "civic_admin_departments",
    "civic_admin_recurrence",
    "civic_admin_reports",
  ];
  for (const fn of fns) {
    const { body } = httpCode([
      "-X",
      "POST",
      `${supaUrl}/rest/v1/rpc/${fn}`,
      "-H",
      `apikey: ${anonKey}`,
      "-H",
      `Authorization: Bearer ${anonKey}`,
      "-H",
      "Content-Type: application/json",
      "-d",
      "{}",
    ]);
    // A refusal is the pass. An array of rows would mean the whole city's data
    // is readable with a key that ships in the JavaScript bundle.
    //
    // "Does not exist" is NOT a pass, even though it also returns no data. A
    // missing function means the migration has not been applied, and treating
    // that as proof the gate works would report green on a console that has
    // never been gated at all.
    const missing = /PGRST202|could not find|does not exist/i.test(body);
    const refused = /not authorised|permission denied|42501/i.test(body);
    if (missing) bad(`${fn} exists`, "migration 0017 not applied yet");
    else check(refused, `${fn} refuses an unauthenticated caller`, refused ? "" : body.slice(0, 90));
  }
} else {
  console.log("  \x1b[33mSKIP\x1b[0m  RPC gating (no Supabase keys in .env.local)");
}

// --------------------------------------------------------------- isolation
console.log("\nSimulated data containment");

const serviceKey = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)?.[1]?.trim();
if (supaUrl && serviceKey) {
  const q = (path) => {
    const { body } = httpCode([
      `${supaUrl}/rest/v1/${path}`,
      "-H",
      `apikey: ${serviceKey}`,
      "-H",
      `Authorization: Bearer ${serviceKey}`,
    ]);
    try {
      return JSON.parse(body.replace(/\n<<\d{3}>>$/, ""));
    } catch {
      return null;
    }
  };

  // The one failure mode that would reach real users: a simulated row written
  // without the flag that hides it.
  const leaked = q("reports?select=id&is_seed=eq.false&id=like.SIM-*");
  check(
    Array.isArray(leaked) && leaked.length === 0,
    "no simulated report is marked as real",
    Array.isArray(leaked) ? `${leaked.length} leaked` : "query failed"
  );

  const sim = q("reports?select=id&is_seed=eq.true&limit=1");
  const real = q("reports?select=id&is_seed=eq.false");
  if (Array.isArray(real)) {
    ok("real ledger readable", `${real.length} non-seed reports`);
  }
  if (Array.isArray(sim)) {
    console.log(
      `  \x1b[36mNOTE\x1b[0m  simulated rows present: ${sim.length > 0 ? "yes" : "no"}`
    );
  }
} else {
  console.log("  \x1b[33mSKIP\x1b[0m  containment (no service-role key in .env.local)");
}

console.log(
  failures === 0
    ? "\n\x1b[32mAll console checks passed.\x1b[0m\n"
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`
);
process.exit(failures === 0 ? 0 : 1);
