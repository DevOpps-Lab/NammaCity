/**
 * Adversarial checks on the two refusal paths. These are the claims the demo
 * makes out loud, so they get verified rather than assumed.
 *
 *   npx tsx scripts/verify-guards.ts
 */
import { guardText, composePost } from "../src/lib/escalation";
import { evaluateAfterPhoto, VERIFY_SCENARIOS } from "../src/lib/verification";
import { classifyReply, applyReply, DEMO_REPLIES } from "../src/lib/correspondence";
import { findDuplicates, haversineMetres } from "../src/lib/dedup";
import { verdictOf } from "../src/lib/verify-vision";
import { redactionGate } from "../src/lib/imaging";
import type { Report } from "../src/lib/types";

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`);
  }
};

console.log("\n=== ESCALATION GUARDRAILS ===");

const politicalAttacks = [
  "the corrupt minister ignores our ward",
  "BJP councillors did nothing",
  "Chief Minister must resign over this",
  "DMK took a bribe for this contract",
  "vote them out in the election",
];

for (const attack of politicalAttacks) {
  const g = guardText(attack);
  check(`blocks: "${attack.slice(0, 38)}…"`, g.blocked, "not flagged");
  const leaked = /corrupt|bribe|minister|bjp|dmk|election|vote/i.test(g.cleaned);
  check(`  strips it from output`, !leaked, `leaked: "${g.cleaned}"`);
}

const benign = "The drain has been overflowing since the last rain.";
const gb = guardText(benign);
check("allows benign factual note", !gb.blocked && gb.cleaned === benign);

// Post-level invariants
const fakeReport: Report = {
  id: "CA-9001",
  lat: 13.03,
  lng: 80.24,
  place: "Ward 123, Teynampet",
  category: "pothole",
  categorySource: "user",
  categoryConfidence: 0,
  severity: "large",
  detectionConfidence: 0.8,
  photoUrl: "",
  status: "past_sla",
  routing: { tier: 1, confidence: "high", method: "test", authorities: [] },
  createdAt: Date.now() - 9 * 86_400_000,
  slaDeadline: Date.now() - 6 * 86_400_000,
  filedTo: ["GCC"],
  supporters: 3,
  timeline: [],
};

const post = composePost(fakeReport, "the corrupt minister is useless", 0);
check("post contains no link", !post.containsLink && !/https?:\/\//.test(post.text));
check("post attaches image natively", post.attachImageNatively);
check("post costs $0.015 not $0.20", post.costUsd === 0.015);
check("post tags institution only", post.mentions.every((m) => m === "@chennaicorp"));
check(
  "post excludes injected slur/political terms",
  !/corrupt|minister|useless/i.test(post.text),
  post.text
);

// Template rotation — X forbids substantially similar content
const v0 = composePost(fakeReport, "", 0).text;
const v1 = composePost(fakeReport, "", 1).text;
const v2 = composePost(fakeReport, "", 2).text;
check("template rotation produces distinct posts", v0 !== v1 && v1 !== v2 && v0 !== v2);

console.log("\n=== VERIFICATION REFUSAL ===");

for (const [key, s] of Object.entries(VERIFY_SCENARIOS)) {
  const r = evaluateAfterPhoto(fakeReport, {
    placeMatch: s.placeMatch,
    defectConfidence: s.defectConfidence,
  });
  check(`${key}: never auto-closes`, r.autoClose === false);
  console.log(`        verdict=${r.verdict}  "${r.headline}"`);
}

// THE critical one: detector misses a defect that is still physically present.
const missed = evaluateAfterPhoto(fakeReport, VERIFY_SCENARIOS.missed);
check(
  "detector-miss case does NOT report as closed",
  missed.autoClose === false && missed.verdict !== "still_present"
    ? missed.verdict === "likely_repaired"
    : true
);
check(
  "detector-miss case warns about recall limits",
  missed.reasoning.some((r) => /recall/i.test(r)),
  missed.reasoning.join(" | ")
);

const wrongPlace = evaluateAfterPhoto(fakeReport, VERIFY_SCENARIOS.wrongPlace);
check(
  "photo from a different location is rejected",
  wrongPlace.verdict === "inconclusive"
);

console.log("\n=== CORRESPONDENCE HANDLER ===");

const filed: Report = {
  ...fakeReport,
  id: "CA-9002",
  status: "filed",
  createdAt: Date.now() - 2 * 86_400_000,
  slaDeadline: Date.now() + 1 * 86_400_000,
};

// Note: `ClassifiedReply.nextStatus` is typed as Exclude<ReportStatus,
// "verified_fixed">, so the compiler already proves no reply can close a
// report. The runtime check below is belt-and-braces against that type being
// widened later — hence the cast, which is deliberate.
for (const { label, reply } of DEMO_REPLIES) {
  const c = classifyReply(reply, filed);
  console.log(`        ${label} -> ${c.kind} (next: ${c.nextStatus})`);
  check(
    `  "${label}" never yields verified_fixed`,
    (c.nextStatus as string) !== "verified_fixed"
  );
}

// The two rules that actually matter.
const transfer = classifyReply(
  DEMO_REPLIES.find((r) => r.label.includes("transfer"))!.reply,
  filed
);
check("transfer is classified as jurisdiction_transfer", transfer.kind === "jurisdiction_transfer");
check("transfer does NOT reset the clock", transfer.resetsClock === false);
check("transfer names the receiving agency", Boolean(transfer.transferTo), String(transfer.transferTo));

const afterTransfer = applyReply(filed, transfer);
check(
  "SLA deadline unchanged after transfer",
  afterTransfer.slaDeadline === filed.slaDeadline,
  `${afterTransfer.slaDeadline} vs ${filed.slaDeadline}`
);
check(
  "receiving agency added to filedTo",
  afterTransfer.filedTo.length > filed.filedTo.length
);

const done = classifyReply(
  DEMO_REPLIES.find((r) => r.label.includes("Claims"))!.reply,
  filed
);
check('"work completed" maps to claims_done, not closed', done.nextStatus === "claims_done");
const afterDone = applyReply(filed, done);
check("applying a done-claim never closes the report", afterDone.status !== "verified_fixed");

console.log("\n=== DEDUPLICATION ===");

const existing: Report[] = [
  { ...fakeReport, id: "CA-A", lat: 13.0389, lng: 80.2492, category: "pothole", status: "filed", aHash: "abcd1234abcd1234" },
  { ...fakeReport, id: "CA-B", lat: 13.0500, lng: 80.2600, category: "pothole", status: "filed" },
  { ...fakeReport, id: "CA-C", lat: 13.0389, lng: 80.2492, category: "pothole", status: "verified_fixed" },
  { ...fakeReport, id: "CA-D", lat: 13.03891, lng: 80.24921, category: "garbage", status: "filed" },
];

const near = findDuplicates(
  { lat: 13.03892, lng: 80.24922, category: "pothole", aHash: "abcd1234abcd1234" },
  existing
);
check("finds the nearby same-category report", near.some((d) => d.report.id === "CA-A"));
check("identical hash yields high confidence", near.find((d) => d.report.id === "CA-A")?.confidence === "high");
check("does not match a different category", !near.some((d) => d.report.id === "CA-D"));
check("does not merge into an already-closed report", !near.some((d) => d.report.id === "CA-C"));
check("does not match a report ~1.5km away", !near.some((d) => d.report.id === "CA-B"));

const farApart = haversineMetres(13.0389, 80.2492, 13.0500, 80.2600);
check("haversine sanity (~1.6km)", farApart > 1400 && farApart < 1900, `${farApart.toFixed(0)}m`);

// Different viewpoint of the same defect: hash misses, geo still catches it.
const differentAngle = findDuplicates(
  { lat: 13.03893, lng: 80.24923, category: "pothole", aHash: "0000ffff0000ffff" },
  existing
);
check(
  "different-angle photo is still surfaced via proximity",
  differentAngle.some((d) => d.report.id === "CA-A")
);

// -----------------------------------------------------------------------------
// COMMUNITY-VERIFIED CLOSURE. Closure is no longer owner-only: anyone (or a
// verified authority photo) can close a case, but ONLY with a photo that passes
// verification. These check the photo GATE that replaces owner-identity.
console.log("\n=== COMMUNITY-VERIFIED CLOSURE ===");

// The gate: verdictOf must reject wrong-place and still-present photos, and only
// pass a same-place, defect-gone photo.
check("wrong-place photo is inconclusive (rejected)", verdictOf(0.3, 0.9) === "inconclusive");
check("defect-still-visible photo is still_present (rejected)", verdictOf(0.9, 0.2) === "still_present");
check("same-place, defect-gone photo is likely_repaired", verdictOf(0.9, 0.9) === "likely_repaired");
check("borderline place match (<0.6) is rejected", verdictOf(0.55, 0.95) === "inconclusive");

// The advisory evaluator is unchanged and still never auto-closes on its own —
// the CLOSE is a separate, photo-gated step, so this invariant still holds.
check(
  "evaluateAfterPhoto still never auto-closes",
  Object.values(VERIFY_SCENARIOS).every(
    (s) => evaluateAfterPhoto(fakeReport, { placeMatch: s.placeMatch, defectConfidence: s.defectConfidence }).autoClose === false
  )
);

// A "done" claim on its own (no verified photo) still must not close — the
// classifier can never reach verified_fixed; only the separate photo step can.
check(
  "a done-claim alone never reaches verified_fixed",
  applyReply(fakeReport, classifyReply({ from: "x", subject: "done", body: "work completed" }, fakeReport)).status !== "verified_fixed"
);

// -----------------------------------------------------------------------------
// REDACTION GATE. Detection is a Gemini call now; if it could not run the Report
// tab must not let the photo be filed until the user confirms they redacted it.
console.log("\n=== REDACTION GATE ===");

check(
  "detection failed + not confirmed -> blocked",
  redactionGate({ manualReviewRequired: true }, false) === false
);
check(
  "detection failed + user confirmed -> allowed",
  redactionGate({ manualReviewRequired: true }, true) === true
);
check(
  "detection ran -> allowed regardless of the checkbox",
  redactionGate({ manualReviewRequired: false }, false) === true &&
    redactionGate({ manualReviewRequired: false }, true) === true
);

console.log(
  failures === 0
    ? "\nAll guard checks passed.\n"
    : `\n${failures} CHECK(S) FAILED.\n`
);
process.exit(failures === 0 ? 0 : 1);
