import type { Report } from "./types";
import type { AuthorityRecord } from "./authorities";
import { DEMO_SINK, DEMO_SOCIAL_HANDLE } from "./authorities";
import { now } from "./demoClock";

/**
 * SANDBOXED OUTBOX
 *
 * Every complaint is composed for real — correct recipient, subject, body,
 * cited SLA — and then routed to a demo sink instead of a government address.
 * The artifacts are kept and made inspectable so the demo can show exactly what
 * WOULD be sent, without sending it.
 *
 * Why not just send it:
 *  - MeitY's E-mail Policy (2024, tightened 2025) requires officials to use
 *    NICeMail exclusively. NICeMail validates SPF/DKIM/DMARC and treats failures
 *    as spoofed spam, and honours org-level admin blocklists — meaning a
 *    department can silently block a sender with NO bounce returned.
 *  - There is no public bounce-rate data for .gov.in from third-party senders,
 *    so real-world deliverability here is genuinely unmeasured.
 *  - Unsolicited automated mail to real officials during a hackathon has no
 *    upside and permanent downside.
 */

export type OutboxKind = "complaint" | "reply" | "post" | "rti";

export interface OutboxItem {
  id: string;
  kind: OutboxKind;
  at: number;
  /** The address we WOULD use in production. */
  intendedTo: string;
  /** Where it actually went. Always the sink. */
  actuallyTo: string;
  subject: string;
  body: string;
  reportId: string;
  /** False when the intended recipient address is not primary-source verified. */
  recipientVerified: boolean;
  delivered: boolean;
}

let seq = 1;

/**
 * States what was actually done to the photograph — never what we hoped.
 *
 * This sentence is an assurance made to a government body about a photograph
 * of a public place, so it has to survive being wrong. It used to read "Faces
 * and identifying details were redacted on the reporting device" for every
 * report unconditionally, and both halves of that could be false: a WhatsApp
 * photo is never device-redacted at all, and in the app the detector can find
 * nothing (or fail to load) and the complaint still went out claiming redaction
 * had happened. A resident filed a photo of an identifiable worker and the mail
 * told the council his face had been blurred.
 *
 * Automatic face detection is not exhaustive and saying so is the point: the
 * recipient can then judge the photo rather than trusting a blanket claim.
 */
function redactionSentence(report: Report, r?: RedactionFacts): string {
  const lead = `A geotagged photograph is attached.`;

  if (report.source === "whatsapp") {
    const n = r?.facesFound ?? 0;
    const what =
      n > 0
        ? `${n} face(s) were detected and pixelated`
        : `it was scanned for faces and none were detected`;
    return `${lead} It was submitted over WhatsApp, so redaction happened on our server rather than on the sender's device: ${what}, and location metadata was stripped, before the photo was stored or sent. Automatic detection is not exhaustive.`;
  }
  if (!r) {
    return `${lead} Location metadata was stripped on the reporting device before transmission.`;
  }
  if (!r.detectorRan) {
    return `${lead} Automatic face redaction could not run on the reporting device, so no faces were blurred. Location metadata was still stripped.`;
  }
  if (r.facesFound > 0) {
    return `${lead} ${r.facesFound} face(s) were detected and pixelated on the reporting device before transmission, and location metadata was stripped. Automatic detection is not exhaustive.`;
  }
  return `${lead} It was scanned for faces on the reporting device and none were detected, so none were pixelated; location metadata was stripped. Automatic detection is not exhaustive — please treat any identifiable person in the image accordingly.`;
}

/** What the on-device redaction pass actually achieved for this photo. */
export interface RedactionFacts {
  facesFound: number;
  /** False when TF.js could not load or run at all. */
  detectorRan: boolean;
}

export function composeComplaint(
  report: Report,
  authority: AuthorityRecord,
  redaction?: RedactionFacts
): OutboxItem {
  const slaHours = Math.round((report.slaDeadline - report.createdAt) / 3_600_000);
  const w = report.routing;

  const body = [
    `To: ${authority.name}`,
    ``,
    `A civic defect has been reported by a resident at the location below.`,
    ``,
    `Complaint reference : ${report.id}`,
    `Category            : ${report.category.replace(/_/g, " ")}`,
    `Severity            : ${report.severity} (ordinal assessment; not a measurement)`,
    `Location            : ${report.place}`,
    `Coordinates         : ${report.lat.toFixed(6)}, ${report.lng.toFixed(6)}`,
    w.ward ? `Ward                : ${w.ward}${w.zoneName ? ` (${w.zoneName}, Zone ${w.zoneNo})` : ""}` : ``,
    `Routing method      : Tier ${w.tier}, confidence ${w.confidence}`,
    `Reported at         : ${new Date(report.createdAt).toLocaleString("en-IN")}`,
    ``,
    `Applicable service standard: ${slaHours} hours.`,
    `Source: ${authority.slaSource}`,
    ``,
    w.ambiguityNote
      ? `Note on jurisdiction: ${w.ambiguityNote}\n`
      : ``,
    // Provenance, stated accurately per intake path. The app redacts faces on
    // the device before anything is uploaded; a photo messaged over WhatsApp
    // reaches our server unmodified and can only have its EXIF stripped there.
    // Claiming the stronger guarantee for both would be a false assurance made
    // to a government body about a photograph of a public place — precisely the
    // kind of confident fiction this product exists to refuse.
    redactionSentence(report, redaction),
    ``,
    `This complaint is tracked publicly. It will be marked resolved only when a`,
    `resident confirms the repair with a photograph from the same location — not`,
    `on a status update alone.`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    id: `OUT-${seq++}`,
    kind: "complaint",
    at: now(),
    intendedTo: authority.email,
    actuallyTo: DEMO_SINK,
    subject: `Civic complaint ${report.id} — ${report.category.replace(/_/g, " ")} at ${report.place}`,
    body,
    reportId: report.id,
    recipientVerified: authority.verified,
    // Starts undelivered: `/api/dispatch` sends it over Gmail SMTP and flips
    // this to true (recording the provider Message-ID). Before that, "not sent"
    // is the honest state — the old `true` was a demo fiction from when nothing
    // was ever actually transmitted.
    delivered: false,
  };
}

export function composeReply(
  report: Report,
  to: string,
  text: string
): OutboxItem {
  return {
    id: `OUT-${seq++}`,
    kind: "reply",
    at: now(),
    intendedTo: to,
    actuallyTo: DEMO_SINK,
    subject: `Re: Civic complaint ${report.id}`,
    body: text,
    reportId: report.id,
    recipientVerified: false,
    delivered: true,
  };
}

export function composePostItem(report: Report, text: string): OutboxItem {
  return {
    id: `OUT-${seq++}`,
    kind: "post",
    at: now(),
    intendedTo: "@chennaicorp (real handle — NOT tagged in demo)",
    actuallyTo: DEMO_SOCIAL_HANDLE,
    subject: `Public escalation — ${report.id}`,
    body: text,
    reportId: report.id,
    recipientVerified: true,
    delivered: true,
  };
}

/**
 * RTI status request. Section 4(1)(b) of the RTI Act 2005 obliges every public
 * authority to proactively publish a directory of its officers; a status
 * request is a cheap, entirely lawful escalation rung between silence and
 * publicity.
 */
export function composeRti(report: Report, authority: AuthorityRecord): OutboxItem {
  const days = Math.floor((now() - report.createdAt) / 86_400_000);
  const body = [
    `Application under the Right to Information Act, 2005`,
    ``,
    `To the Public Information Officer, ${authority.name}`,
    ``,
    `Regarding complaint ${report.id}, filed ${new Date(report.createdAt).toLocaleDateString("en-IN")}`,
    `concerning a ${report.category.replace(/_/g, " ")} at ${report.place}, which remains`,
    `unresolved after ${days} days:`,
    ``,
    `1. What action has been taken on this complaint to date, with dates?`,
    `2. Which officer or post is responsible for this work?`,
    `3. What is the published service standard for this category of work, and`,
    `   what was the reason for exceeding it in this case?`,
    `4. Please provide the department's disclosure under Section 4(1)(b) listing`,
    `   officers and their responsibilities for this ward.`,
    ``,
    `The applicant seeks this information in the public interest.`,
  ].join("\n");

  return {
    id: `OUT-${seq++}`,
    kind: "rti",
    at: now(),
    intendedTo: authority.email,
    actuallyTo: DEMO_SINK,
    subject: `RTI application — status of complaint ${report.id}`,
    body,
    reportId: report.id,
    recipientVerified: authority.verified,
    delivered: true,
  };
}
