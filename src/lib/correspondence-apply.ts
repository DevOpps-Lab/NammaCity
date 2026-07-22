import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyReply, applyReply, type InboundReply } from "./correspondence";
import { composeReply } from "./outbox";
import { composeUpdate, guardText } from "./escalation";
import { sendMail, normalizeMessageId } from "./email/gmail";
import { verifyAfterPhoto } from "./verify-vision";
import { postSocial } from "./social";
import * as db from "./db";
import { now } from "./demoClock";
import type { Report } from "./types";

/**
 * Post a status update to the Namma Chennai timeline (and to real X when keys
 * are set), server-side, so the email round-trip drives the public timeline the
 * same way the client simulate path does. Best-effort: never blocks the reply.
 */
async function postUpdateToTimeline(
  admin: SupabaseClient,
  report: Report,
  userId: string
): Promise<void> {
  const guard = guardText(composeUpdate(report).text);
  const text = (guard.cleaned || composeUpdate(report).text).slice(0, 280);
  let source: "x" | "bluesky" | "simulated" = "simulated";
  let tweetId: string | null = null;
  let tweetUrl: string | null = null;

  let image: { content: Buffer; mimeType: string } | null = null;
  if (report.photoUrl && !report.photoUrl.startsWith("data:")) {
    try {
      const res = await fetch(report.photoUrl);
      if (res.ok) {
        image = {
          content: Buffer.from(await res.arrayBuffer()),
          mimeType: res.headers.get("content-type") ?? "image/jpeg",
        };
      }
    } catch {
      /* post text-only */
    }
  }
  const posted = await postSocial({ text, image });
  if (posted) {
    source = posted.platform;
    tweetId = posted.id;
    tweetUrl = posted.url;
  }

  await admin.from("public_posts").insert({
    report_id: report.id,
    kind: "update",
    body: text,
    source,
    tweet_id: tweetId,
    tweet_url: tweetUrl,
    author: userId,
    at: now(),
  });
}

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
      await postUpdateToTimeline(admin, updated, input.userId);
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

  return {
    matched: true,
    kind: classified.kind,
    nextStatus: closed ? "verified_fixed" : updated.status,
    autoResponded,
    closed,
  };
}
