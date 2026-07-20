/**
 * Two-account RLS check for the community map.
 *
 * The map became readable by every signed-in citizen. This asserts that opening
 * up SELECT did not open up anything else — the product's core refusal is that
 * only the citizen who filed a report can close it, and that has to hold at the
 * database layer, not merely in a UI that hides the button.
 *
 *   node scripts/verify-rls.mjs
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local
 * and the two demo accounts.
 */
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Two throwaway accounts on your own project. Supplied via env rather than
// hardcoded, so this file carries no working password into the repository.
//
//   RLS_A_EMAIL=... RLS_A_PASSWORD=... \
//   RLS_B_EMAIL=... RLS_B_PASSWORD=... node scripts/verify-rls.mjs
const A = { email: process.env.RLS_A_EMAIL, password: process.env.RLS_A_PASSWORD };
const B = { email: process.env.RLS_B_EMAIL, password: process.env.RLS_B_PASSWORD };

if (!A.email || !A.password || !B.email || !B.password) {
  console.error(
    [
      "Set RLS_A_EMAIL / RLS_A_PASSWORD / RLS_B_EMAIL / RLS_B_PASSWORD to two",
      "accounts on your project. They must be DIFFERENT accounts — the whole",
      "point is proving one cannot close the other's reports.",
    ].join("\n")
  );
  process.exit(2);
}

let pass = 0;
let fail = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
};

// Node's fetch resets pooled sockets against this host; retry transport errors.
async function rf(url, init, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 150 * 2 ** i));
    }
  }
  throw last;
}

async function signIn({ email, password }) {
  const res = await rf(`${URL_}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error(`sign-in failed for ${email}: ${JSON.stringify(j)}`);
  return { token: j.access_token, id: j.user.id };
}

const H = (t) => ({ apikey: ANON, Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

console.log("\n=== COMMUNITY MAP RLS ===\n");

const a = await signIn(A);
const b = await signIn(B);

// A files a real (non-seed) report.
const id = `RLSTEST-${Date.now()}`;
const now = Date.now();
const ins = await rf(`${URL_}/rest/v1/reports`, {
  method: "POST",
  headers: { ...H(a.token), Prefer: "return=representation" },
  body: JSON.stringify({
    id,
    user_id: a.id,
    lat: 13.06,
    lng: 80.25,
    place: "RLS probe",
    category: "pothole",
    severity: "large",
    status: "filed",
    routing: {},
    created_at: now,
    sla_deadline: now + 72 * 3600000,
    filed_to: [],
    supporters: 0,
    is_seed: false,
  }),
});
check(ins.status === 201, "A can file a report", `HTTP ${ins.status}`);

// --- the community read ---
const bSees = await (
  await rf(`${URL_}/rest/v1/reports?id=eq.${id}&select=id,status`, { headers: H(b.token) })
).json();
check(bSees.length === 1, "B can SEE A's real report on the community map");

// --- seeds stay private, or the map stacks N copies of every demo pin ---
const bSeeds = await (
  await rf(`${URL_}/rest/v1/reports?id=eq.CA-4520&select=id,user_id`, { headers: H(b.token) })
).json();
const foreignSeeds = bSeeds.filter((r) => r.user_id !== b.id);
check(foreignSeeds.length === 0, "B does NOT see other accounts' seeded reports", `${bSeeds.length} row(s), all own`);

// --- THE REFUSAL: B must not be able to close A's report ---
const close = await (
  await rf(`${URL_}/rest/v1/reports?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...H(b.token), Prefer: "return=representation" },
    body: JSON.stringify({ status: "verified_fixed" }),
  })
).json();
check(Array.isArray(close) && close.length === 0, "B CANNOT close A's report (0 rows affected)");

const escalate = await (
  await rf(`${URL_}/rest/v1/reports?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...H(b.token), Prefer: "return=representation" },
    body: JSON.stringify({ status: "escalated" }),
  })
).json();
check(Array.isArray(escalate) && escalate.length === 0, "B CANNOT escalate A's report");

const del = await rf(`${URL_}/rest/v1/reports?id=eq.${id}`, {
  method: "DELETE",
  headers: { ...H(b.token), Prefer: "return=representation" },
});
const delBody = await del.json();
check(Array.isArray(delBody) && delBody.length === 0, "B CANNOT delete A's report");

// --- and it really is untouched ---
const after = await (
  await rf(`${URL_}/rest/v1/reports?id=eq.${id}&select=status`, { headers: H(a.token) })
).json();
check(after[0]?.status === "filed", "A's report is still 'filed' after all three attempts", after[0]?.status);

// --- A retains full control of their own ---
const ownClose = await (
  await rf(`${URL_}/rest/v1/reports?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...H(a.token), Prefer: "return=representation" },
    body: JSON.stringify({ status: "verified_fixed" }),
  })
).json();
check(ownClose.length === 1, "A CAN close their own report");

// cleanup
await rf(`${URL_}/rest/v1/reports?id=eq.${id}`, { method: "DELETE", headers: H(a.token) });

console.log(`\n${fail === 0 ? "All RLS checks passed." : `${fail} CHECK(S) FAILED`}  (${pass} passed)\n`);
process.exit(fail === 0 ? 0 : 1);
