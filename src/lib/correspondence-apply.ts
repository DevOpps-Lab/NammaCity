import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyReply, applyReply, type InboundReply } from "./correspondence";
import { composeReply } from "./outbox";
import { composeUpdate } from "./escalation";
import { sendMail, normalizeMessageId } from "./email/gmail";
import { verifyAfterPhoto } from "./verify-vision";
import { postReportUpdate } from "./public-post";
import { notifyStatus } from "./whatsapp/notify";
import * as db from "./db";
import { now } from "./demoClock";

/**
 * SERVER-SIDE correspondence handler — the twin of `store.receiveReply()`.
 *
 * When a real authority reply arrives by email (no browser, no session), the
 * inbound webhook resolves which (userId, reportId) it belongs to and calls
 * this with the service-role client. It reuses the SAME pure rules the client
 * uses — `classifyReply()` / `applyReply()` from `correspondence.ts` — so a
 * jurisdiction transfer still does not reset the clock, and, load-bearingly,
 * `nextStatus` is typed `Exclude<ReportStatus, "verified_fixed">`: the server
 * path is structurally incapable of auto-closing a ticket. An authority saying
 * "done" moves it to `claims_done` (the verify-awaiting state), never closed.
 */

export interface ApplyInboundInput {
  userId: string;
  reportId: string;
  reply: InboundReply;
  /** The inbound email's own Message-ID, so our auto-response threads onto it. */
  inReplyToMessageId?: string;
  /** An image attached to the reply — an authority "done" claim can be verified. */
  image?: { content: Buffer; mimeType: string } | null;
}

export interface ApplyInboundResult {
  matched: true;
  kind: string;
  nextStatus: string;
  autoResponded: boolean;
  /** True when an attached authority photo verified and closed the case. */
  closed?: boolean;
}

export async function applyInboundReply(
  admin: SupabaseClient,
  input: ApplyInboundInput
): Promise<ApplyInboundResult | { matched: false }> {
  const report = await db.fetchReportByOwner(admin, input.userId, input.reportId);
  if (!report) return { matched: false };

  const classified = classifyReply(input.reply, report);
  const updated = applyReply(report, classified);

  await db.updateReport(admin, report.id, input.userId, {
    status: updated.status,
    slaDeadline: updated.slaDeadline,
    filedTo: updated.filedTo,
    timeline: updated.timeline,
  });

  await db.insertInboundReply(admin, input.userId, report.id, {
    at: now(),
    from: input.reply.from,
    subject: input.reply.subject,
    body: input.reply.body,
    kind: classified.kind,
  });

  // Keep the public Namma Chennai timeline current from real email replies too
  // — a transfer, a "done" claim, or a rejection are all worth surfacing. A
  // bare acknowledgement is noise, so it is skipped.
  if (classified.kind !== "acknowledged") {
    try {
      await postReportUpdate(admin, updated, input.userId, "update");
    } catch {
      /* best-effort */
    }
  }

  // `acknowledged` deliberately carries no autoResponse — replying to a bare
  // acknowledgement is noise. Everything else gets an auto-reply sent for real,
  // then recorded in the outbox as delivered.
  let autoResponded = false;
  if (classified.autoResponse) {
    const item = composeReply(updated, input.reply.from, classified.autoResponse);
    let messageId: string | null = null;
    try {
      const res = await sendMail({
        to: input.reply.from,
        subject: item.subject,
        text: item.body,
        inReplyTo: input.inReplyToMessageId,
      });
      messageId = normalizeMessageId(res.messageId);
      autoResponded = true;
    } catch {
      // Send failed — still record the composed reply so the thread is complete.
    }

    await admin.from("outbox_items").insert({
      user_id: input.userId,
      report_id: report.id,
      kind: item.kind,
      at: item.at,
      intended_to: input.reply.from,
      actually_to: autoResponded ? input.reply.from : item.actuallyTo,
      subject: item.subject,
      body: item.body,
      recipient_verified: false,
      delivered: autoResponded,
      provider_message_id: messageId,
      delivered_at: autoResponded ? now() : null,
    });
  }

  // AUTHORITY-PHOTO CLOSE: a "done" claim WITH an attached image can close the
  // case — but only if the image actually VERIFIES (same place, defect gone).
  // No vision check (Gemini absent/over-limit) => no close, stays claims_done.
  let closed = false;
  if (classified.kind === "claims_done" && input.image) {
    const dataUrl = `data:${input.image.mimeType};base64,${input.image.content.toString("base64")}`;
    const check = await verifyAfterPhoto({
      afterDataUrl: dataUrl,
      beforeUrl: report.photoUrl,
      category: report.category,
    });
    if (check.configured && check.verdict === "likely_repaired") {
      const path = `${input.userId}/${report.id}-after-${now()}.jpg`;
      let afterUrl = "";
      const up = await admin.storage
        .from("report-photos")
        .upload(path, input.image.content, {
          contentType: input.image.mimeType,
          upsert: true,
        });
      if (!up.error) {
        afterUrl = admin.storage.from("report-photos").getPublicUrl(path).data.publicUrl;
      }
      if (afterUrl) {
        closed = await db.verifyAndClose(admin, {
          owner: input.userId,
          reportId: report.id,
          afterUrl,
          source: "an authority photo (auto-verified)",
          now: now(),
        });
        if (closed) {
          // Announce the resident-grade win on the public timeline.
          await admin.from("public_posts").insert({
            report_id: report.id,
            kind: "update",
            body: composeUpdate({ ...updated, status: "verified_fixed" }).text,
            source: "simulated",
            author: input.userId,
            at: now(),
          });
        }
      }
    }
  }

  // TELL THE CITIZEN. A report filed over WhatsApp has no browser to notify and
  // no account to email, so `claims_done` — the one state the loop cannot leave
  // without a human — would otherwise sit unseen until they happened to reopen
  // their tracking link. `notifyStatus` is a no-op for reports filed in the app
  // (no stored number) and when Twilio is unconfigured, so this costs one
  // indexed lookup on the ordinary path.
  //
  // Only one message: if the authority's own photo already verified and closed
  // the case, asking for an after-photo would be asking for work already done.
  try {
    if (closed) {
      await notifyStatus(admin, {
        owner: input.userId,
        reportId: report.id,
        kind: "verified_fixed",
      });
    } else if (classified.kind === "claims_done") {
      await notifyStatus(admin, {
        owner: input.userId,
        reportId: report.id,
        kind: "claims_done",
      });
    }
  } catch (err) {
    // Best-effort by design: a notification failure must never cost us the
    // correspondence record, which is the part that is actually load-bearing.
    console.warn("[correspondence] citizen notification failed", err);
  }

  return {
    matched: true,
    kind: classified.kind,
    nextStatus: closed ? "verified_fixed" : updated.status,
    autoResponded,
    closed,
  };
}
