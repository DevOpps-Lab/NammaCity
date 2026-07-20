import type { Report, ReportStatus } from "./types";
import { now } from "./demoClock";

/**
 * CORRESPONDENCE HANDLER
 *
 * Classifies replies from authorities and decides what each one does to the
 * report. The load-bearing rules:
 *
 *  1. A jurisdiction transfer is NOT a closure. The Standing Committee on
 *     Public Grievances (Dec 2021) found grievances routinely "disposed" by
 *     telling the citizen to go elsewhere. Mumbai 2025: 727 of 10,361 pothole
 *     complaints were bounced to other agencies. So a transfer re-files to the
 *     named agency and the ORIGINAL clock keeps running.
 *
 *  2. "Done" is not done. `claims_done` is a distinct state from
 *     `verified_fixed` and only a citizen with an after-photo can bridge them.
 */

export type ReplyKind =
  | "acknowledged"
  | "query"
  | "jurisdiction_transfer"
  | "claims_done"
  | "rejected";

export interface InboundReply {
  from: string;
  subject: string;
  body: string;
}

export interface ClassifiedReply {
  kind: ReplyKind;
  /** Agency named in a transfer, when we can extract one. */
  transferTo?: string;
  /** What we send back, if anything. */
  autoResponse?: string;
  /** Status the report moves to. Never `verified_fixed`. */
  nextStatus: Exclude<ReportStatus, "verified_fixed">;
  /** Whether the SLA clock restarts. Almost always false, by design. */
  resetsClock: boolean;
  note: string;
}

const PATTERNS: {
  kind: ReplyKind;
  test: RegExp;
}[] = [
  {
    kind: "jurisdiction_transfer",
    test: /not (?:our|under our)|belongs to|forwarded to|refer(?:red)? to|kindly approach|different department|outside our jurisdiction|transferred to/i,
  },
  {
    kind: "claims_done",
    test: /(?:work |issue |complaint )?(?:has been |is )?(?:completed|resolved|rectified|attended|closed|done|fixed)/i,
  },
  {
    kind: "rejected",
    test: /cannot be|not feasible|no funds|budget|rejected|invalid complaint|duplicate/i,
  },
  {
    kind: "query",
    test: /\?|please (?:provide|share|confirm|specify)|need more|clarif|exact location|landmark/i,
  },
  {
    kind: "acknowledged",
    test: /acknowledg|received|registered|noted|under process|taken up/i,
  },
];

function extractAgency(body: string): string | undefined {
  const m = body.match(
    /(?:refer(?:red)? to|forwarded to|belongs to|approach)\s+(?:the\s+)?([A-Z][A-Za-z&.\s]{2,40})/
  );
  return m?.[1]?.trim().replace(/[.,]$/, "");
}

export function classifyReply(reply: InboundReply, report: Report): ClassifiedReply {
  const text = `${reply.subject} ${reply.body}`;

  const matched = PATTERNS.find((p) => p.test.test(text))?.kind ?? "acknowledged";

  switch (matched) {
    case "jurisdiction_transfer": {
      const to = extractAgency(reply.body);
      return {
        kind: matched,
        transferTo: to,
        nextStatus: "transferred",
        // The critical rule. Passing the buck must not buy time.
        resetsClock: false,
        autoResponse:
          `Re: ${report.id} — noted. Re-filing to ${to ?? "the named agency"}. ` +
          `Please note the original complaint clock is unchanged; a transfer between agencies is not a resolution. ` +
          `Where responsibility is disputed, Bombay HC (13 Oct 2025) holds that agencies may not create "no-man's zones".`,
        note: `Transferred${to ? ` to ${to}` : ""}. Re-filed. SLA clock NOT reset.`,
      };
    }

    case "claims_done":
      return {
        kind: matched,
        // Explicitly NOT verified_fixed.
        nextStatus: "claims_done",
        resetsClock: false,
        autoResponse:
          `Re: ${report.id} — thank you. This will be marked resolved once a resident ` +
          `confirms with a photograph from the same location. Until then it remains open on the public ledger.`,
        note: "Authority claims resolved. Awaiting citizen verification — not closed.",
      };

    case "query":
      return {
        kind: matched,
        nextStatus: "acknowledged",
        resetsClock: false,
        autoResponse:
          `Re: ${report.id} — location: ${report.place} (${report.lat.toFixed(5)}, ${report.lng.toFixed(5)}). ` +
          `Category: ${report.category.replace(/_/g, " ")}. Severity: ${report.severity}. ` +
          `Geotagged photograph was attached to the original complaint and is available on request.`,
        note: "Query answered automatically from the complaint record.",
      };

    case "rejected":
      return {
        kind: matched,
        nextStatus: "past_sla",
        resetsClock: false,
        autoResponse:
          `Re: ${report.id} — recorded. A rejection without remedial action does not close the ` +
          `complaint on this ledger; it will remain visible with the stated reason.`,
        note: "Rejected by authority. Stays open publicly with the reason recorded.",
      };

    default:
      return {
        kind: "acknowledged",
        nextStatus: "acknowledged",
        resetsClock: false,
        note: "Acknowledged by authority. Clock continues.",
      };
  }
}

export function applyReply(report: Report, classified: ClassifiedReply): Report {
  return {
    ...report,
    status: classified.nextStatus,
    // Deliberately does not touch slaDeadline unless resetsClock is true.
    slaDeadline: classified.resetsClock
      ? now() + (report.slaDeadline - report.createdAt)
      : report.slaDeadline,
    filedTo: classified.transferTo
      ? Array.from(new Set([...report.filedTo, classified.transferTo]))
      : report.filedTo,
    timeline: [
      ...report.timeline,
      { at: now(), kind: classified.kind, detail: classified.note },
    ],
  };
}

/** Canned inbound replies for the demo — one per class. */
export const DEMO_REPLIES: { label: string; reply: InboundReply }[] = [
  {
    label: "Acknowledgement",
    reply: {
      from: "seswd@chennaicorporation.gov.in",
      subject: "Complaint registered",
      body: "Your complaint has been received and registered. It has been taken up for process.",
    },
  },
  {
    label: "Query",
    reply: {
      from: "seswd@chennaicorporation.gov.in",
      subject: "Need more details",
      body: "Please provide the exact location and a nearby landmark for the reported issue?",
    },
  },
  {
    label: "Jurisdiction transfer (the dodge)",
    reply: {
      from: "seswd@chennaicorporation.gov.in",
      subject: "Not under our department",
      body: "This location is not our jurisdiction. Kindly approach CMWSSB for further action.",
    },
  },
  {
    label: "Claims done",
    reply: {
      from: "seswd@chennaicorporation.gov.in",
      subject: "Work completed",
      body: "The reported issue has been rectified and the complaint is closed at our end.",
    },
  },
  {
    label: "Rejected",
    reply: {
      from: "seswd@chennaicorporation.gov.in",
      subject: "Cannot be taken up",
      body: "This work cannot be taken up currently due to no funds in the present budget.",
    },
  },
];
