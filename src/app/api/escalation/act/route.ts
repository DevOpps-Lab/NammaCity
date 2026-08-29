import { NextResponse } from "next/server";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { authorisedScheduler } from "@/lib/api-auth";
import { composeRti } from "@/lib/outbox";
import { sendMail, gmailConfigured, normalizeMessageId } from "@/lib/email/gmail";
import { complaintTextToHtml } from "@/lib/email/render";
import * as db from "@/lib/db";
import { now } from "@/lib/demoClock";
import type { AuthorityRecord } from "@/lib/authorities";

/**
 * ESCALATION LADDER — take the next rung for one report.
 *
 * Deliberately one report per call. An orchestrator batches, and a failure on
 * one report must not abort a sweep of thirty.
 *
 * WHERE THE MAIL GOES. To `DEMO_AUTHORITY_EMAIL`, exactly like every complaint,
 * and this is the least negotiable line in the file. An RTI application names a
 * Public Information Officer and starts a statutory clock against them
 * personally. Sending one automatically, on a schedule, to a real officer — as a
 * side effect of a demo — is precisely the harm the sandbox exists to prevent,
 * and it would be worse than the fraud this product was built to expose.
 */

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!(await authorisedScheduler(req))) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  let reportId: unknown, owner: unknown, rung: unknown;
  try {
    ({ reportId, owner, rung } = await req.json());
  } catch {
    return NextResponse.json({ error: "Malformed body" }, { status: 400 });
  }
  if (typeof reportId !== "string" || typeof owner !== "string") {
    return NextResponse.json({ error: "reportId and owner required" }, { status: 400 });
  }
  if (rung !== "rti") {
    // Councillor and press rungs need `outbox_items.kind` widening beyond
    // ('complaint','reply','post','rti'), so they are refused rather than
    // silently written as something they are not.
    return NextResponse.json({ error: "Unsupported rung" }, { status: 400 });
  }
  if (!adminConfigured()) {
    return NextResponse.json({ acted: false, reason: "unconfigured" });
  }

  const admin = createAdminClient();

  // Scoped by owner: the reports PK is (user_id, id) and ids repeat across
  // accounts, so an id alone addresses nothing.
  const report = await db.fetchReportByOwner(admin, owner, reportId);
  if (!report) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (report.status !== "escalated") {
    return NextResponse.json({ acted: false, reason: "not_escalated", status: report.status });
  }

  // Idempotence, and the same test the candidates endpoint uses. Checked again
  // here because the orchestrator may retry after a timeout that actually
  // succeeded — an RTI sent twice reads as harassment, not persistence.
  const { count } = await admin
    .from("outbox_items")
    .select("*", { count: "exact", head: true })
    .eq("user_id", owner)
    .eq("report_id", reportId)
    .eq("kind", "rti");
  if ((count ?? 0) > 0) {
    return NextResponse.json({ acted: false, reason: "already_sent" });
  }

  const authorities = (report.routing.authorities ?? []) as AuthorityRecord[];
  const authority = authorities[0];
  if (!authority) {
    return NextResponse.json({ acted: false, reason: "no_authority" });
  }

  const item = composeRti(report, authority);

  const sink = process.env.DEMO_AUTHORITY_EMAIL;
  let delivered = false;
  let messageId: string | null = null;
  let deliveryError: string | null = null;

  if (gmailConfigured() && sink) {
    try {
      const res = await sendMail({
        to: sink,
        subject: item.subject,
        text: item.body,
        html: complaintTextToHtml(item.subject, item.body),
      });
      messageId = normalizeMessageId(res.messageId);
      delivered = true;
    } catch (err) {
      deliveryError = err instanceof Error ? err.message : "send failed";
    }
  } else {
    deliveryError = "gmail or DEMO_AUTHORITY_EMAIL not configured";
  }

  // Recorded either way. An RTI that failed to send is still a rung we tried,
  // and the outbox is the audit trail — hiding the attempt would make the
  // ledger a worse record than the thing it is auditing.
  const { error: insErr } = await admin.from("outbox_items").insert({
    user_id: owner,
    report_id: reportId,
    kind: "rti",
    at: item.at,
    intended_to: authority.email,
    actually_to: delivered ? sink : item.actuallyTo,
    subject: item.subject,
    body: item.body,
    recipient_verified: authority.verified,
    delivered,
    provider_message_id: messageId,
    delivered_at: delivered ? now() : null,
    delivery_error: deliveryError,
  });
  if (insErr) {
    console.error("[escalation] could not record the RTI", insErr.message);
    return NextResponse.json({ error: "record failed" }, { status: 502 });
  }

  await db.appendTimeline(admin, reportId, owner, [
    {
      at: now(),
      kind: "rti",
      detail: `RTI status request filed with ${authority.name} — the RTI Act sets a statutory 30-day deadline.`,
    },
  ]);

  return NextResponse.json({
    acted: true,
    rung: "rti",
    reportId,
    delivered,
    deliveryError,
    intendedTo: authority.email,
  });
}
