import type { Report } from "./types";
import { now } from "./demoClock";

/**
 * ESCALATION POST COMPOSER + GUARDRAILS
 *
 * We post from one official product account, which means WE are the publisher
 * with full primary liability — there is no intermediary safe harbour for
 * content we author. Every rule below is a direct consequence.
 *
 * Legal basis for the shape of these posts:
 *  - BNS s.356 Exception 2 protects good-faith truthful comment on a public
 *    servant's conduct in discharge of public function. So: verifiable facts,
 *    no characterisation.
 *  - R. Rajagopal v. State of TN (1994): the State and its organs cannot sue
 *    for defamation. So: address institutions, never individuals — naming an
 *    officer forfeits that shield and invites a private criminal complaint.
 *  - The Agra case: a man was arrested over a pothole video that ALSO carried a
 *    remark about the Chief Minister. The civic fact was not the trigger; the
 *    bundled political remark was. So: hard political firewall.
 *  - X charges $0.015/post but $0.20/post with a link (13x). So: image native,
 *    complaint ID in plain text, never a URL.
 */

/** Deterministic blocklist. Runs BEFORE any model call, and independently of it. */
const POLITICAL_TERMS = [
  "chief minister",
  "cm ",
  "prime minister",
  "pm ",
  "minister",
  "mla",
  "mp ",
  "bjp",
  "congress",
  "dmk",
  "aiadmk",
  "aap",
  "tmc",
  "government of",
  "ruling party",
  "opposition",
  "election",
  "vote",
  "modi",
  "stalin",
];

const DEFAMATORY_TERMS = [
  "corrupt",
  "corruption",
  "bribe",
  "bribery",
  "kickback",
  "stole",
  "steal",
  "theft",
  "criminal",
  "incompetent",
  "lazy",
  "useless",
  "negligent",
  "fraud",
  "scam",
  "liar",
  "lying",
];

export interface GuardResult {
  blocked: boolean;
  /** Terms that were stripped, with the reason each one is unsafe. */
  violations: { term: string; category: "political" | "defamatory"; reason: string }[];
  cleaned: string;
}

export function guardText(input: string): GuardResult {
  const lower = input.toLowerCase();
  const violations: GuardResult["violations"] = [];

  for (const t of POLITICAL_TERMS) {
    if (lower.includes(t)) {
      violations.push({
        term: t.trim(),
        category: "political",
        reason:
          "Political content is the documented arrest trigger (Agra, 2025). The pothole was never the offence, the remark about the CM was.",
      });
    }
  }

  for (const t of DEFAMATORY_TERMS) {
    if (lower.includes(t)) {
      violations.push({
        term: t.trim(),
        category: "defamatory",
        reason:
          "Imputations of dishonesty fall outside the BNS s.356 Exception 2 public-conduct shield. This is where officials actually file complaints.",
      });
    }
  }

  // Strip offending sentences rather than mangling words mid-phrase.
  let cleaned = input;
  if (violations.length) {
    cleaned = input
      .split(/(?<=[.!?])\s+/)
      .filter((sentence) => {
        const s = sentence.toLowerCase();
        return ![...POLITICAL_TERMS, ...DEFAMATORY_TERMS].some((t) => s.includes(t));
      })
      .join(" ")
      .trim();
  }

  return { blocked: violations.length > 0, violations, cleaned };
}

export interface ComposedPost {
  text: string;
  /** Institution handles only. Never a named officer's personal account. */
  mentions: string[];
  attachImageNatively: true;
  containsLink: false;
  guard: GuardResult;
  costUsd: number;
}

const TEMPLATES = [
  (r: Report, days: number, sla: number) =>
    `Complaint ${r.id}, ${r.place}.\nFiled ${fmt(r.createdAt)}. Still open after ${days} days.\nPublished service standard: ${sla} hours.`,
  (r: Report, days: number, sla: number) =>
    `${days} days open. Complaint ${r.id}, ${r.place}.\nThe published commitment for this service is ${sla} hours.\nStatus: unresolved.`,
  (r: Report, days: number, sla: number) =>
    `Still unresolved: ${r.id} (${r.place}).\nDay ${days}. Stated service standard: ${sla} hours.\nReported by a resident, evidence attached.`,
];

/**
 * Template rotation matters: X's automation rules forbid posting "identical or
 * substantially similar content", and a template bot tagging municipal handles
 * is the textbook suspension pattern. Account termination would end the product
 * faster than any lawsuit.
 */
export function composePost(
  report: Report,
  userNote = "",
  variantSeed = 0
): ComposedPost {
  const guard = guardText(userNote);
  const days = Math.max(1, Math.floor((now() - report.createdAt) / 86_400_000));
  const slaHours = Math.round((report.slaDeadline - report.createdAt) / 3_600_000);

  const template = TEMPLATES[variantSeed % TEMPLATES.length];
  let text = template(report, days, slaHours);

  if (guard.cleaned) text += `\n\n${guard.cleaned}`;

  const mentions = ["@chennaicorp"];
  text += `\n\n${mentions.join(" ")}`;

  return {
    text,
    mentions,
    attachImageNatively: true,
    containsLink: false,
    guard,
    // $0.015 without a link; $0.20 with one.
    costUsd: 0.015,
  };
}

function fmt(ms: number) {
  return new Date(ms).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * A short, factual status-update post. Same rules as an escalation: institution
 * handle only, no link, image-native, no characterisation. Used to keep the
 * public timeline current as a case moves — acknowledged, transferred (clock
 * still running), claimed-but-unverified, and resident-verified fixes. The
 * verified-fix line is deliberately the loud one: it is the honest win.
 */
export function composeUpdate(report: Report): ComposedPost {
  const days = Math.max(1, Math.floor((now() - report.createdAt) / 86_400_000));
  const cat = report.category.replace(/_/g, " ");

  const LINES: Partial<Record<Report["status"], string>> = {
    acknowledged: `Update on ${report.id} (${report.place}): the authority has acknowledged this ${cat} complaint. The published clock keeps running.`,
    transferred: `Update on ${report.id} (${report.place}): the agency says this ${cat} belongs to another department. Re-filed. The original clock is NOT reset.`,
    claims_done: `Update on ${report.id} (${report.place}): the authority claims this ${cat} is fixed. Unverified, awaiting a resident's after-photo before it counts as closed.`,
    past_sla: `Update on ${report.id} (${report.place}): this ${cat} has now passed the authority's own published service standard, ${days} days on.`,
    escalated: `Update on ${report.id} (${report.place}): still unresolved after ${days} days, past the published standard.`,
    verified_fixed: `Resolved ✅ ${report.id} (${report.place}): a resident has confirmed this ${cat} is fixed with an after-photo. Citizen-verified, not just claimed.`,
  };

  const text = `${LINES[report.status] ?? `Update on ${report.id} (${report.place}).`}\n\n@chennaicorp`;

  return {
    text,
    mentions: ["@chennaicorp"],
    attachImageNatively: true,
    containsLink: false,
    guard: { blocked: false, violations: [], cleaned: "" },
    costUsd: 0.015,
  };
}

/**
 * Aggregate ward-level post. Safer than per-issue accusation, much harder to
 * challenge, and far more likely to get a journalist to call — which is where
 * real pressure comes from. Bias the account toward these.
 */
export function composeWardSummary(
  reports: Report[],
  wardLabel: string
): ComposedPost {
  const breached = reports.filter((r) => now() > r.slaDeadline);
  const medianAge =
    breached.length === 0
      ? 0
      : Math.floor(
          [...breached]
            .map((r) => (now() - r.createdAt) / 86_400_000)
            .sort((a, b) => a - b)[Math.floor(breached.length / 2)]
        );

  const text =
    `${wardLabel}: ${reports.length} complaints filed, ${breached.length} now past their published service standard.\n` +
    `Median age of overdue items: ${medianAge} days.\n\n@chennaicorp`;

  return {
    text,
    mentions: ["@chennaicorp"],
    attachImageNatively: true,
    containsLink: false,
    guard: { blocked: false, violations: [], cleaned: "" },
    costUsd: 0.015,
  };
}
