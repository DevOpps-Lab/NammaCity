import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, adminConfigured } from "@/lib/supabase/admin";
import { fetchUnseen, markSeen, imapConfigured } from "@/lib/email/inbound";
import { applyInboundReply } from "@/lib/correspondence-apply";
import { findIntakeUserId } from "@/lib/whatsapp/intake";
import { sweepAndNotify } from "@/lib/whatsapp/notify";
import type { InboundReply } from "@/lib/correspondence";

/**
 * INBOUND POLL — sweeps the system Gmail inbox for authority replies and runs
 * each through the server-side correspondence handler.
 *
 * Triggered two ways:
 *  - the app's own client, every few seconds while open + a manual "Check
 *    inbox" button — authorised by the caller's Supabase session; or
 *  - a cron/backstop — authorised by the INBOUND_POLL_SECRET header.
 *
 * It processes ALL unseen mail in the shared system inbox and routes each
 * message to its OWNER via the stored provider Message-ID, regardless of who
 * triggered the poll. In this single-inbox demo that is the intended behaviour.
 *
 * IDEMPOTENCE, and how it was wrong. This used to claim that flagging a message
 * \Seen only after applying it made re-runs safe. It does the opposite: the
 * apply sends SMTP mail, posts to the public timeline and can run a Gemini
 * vision check, so the window between fetch and \Seen is seconds wide — and the
 * client polls every 30s (5s on the demo clock) from every open tab. Overlapping
 * polls re-fetched the same unseen message and applied it again. One authority
 * reply put six identical auto-replies in a citizen's inbox.
 *
 * Two layers now. The real guarantee is in Postgres: applyInboundReply claims
 * the email against a unique index on inbound_replies.provider_message_id
 * before any side effect, so a replay loses the race and stops. The in-flight
 * guard below is just courtesy — it keeps one instance from stampeding itself,
 * and cannot help across instances or tabs, which is exactly why it is not the
 * mechanism relied upon.
 */

export const runtime = "nodejs";

/**
 * One poll at a time per instance. Concurrent callers get the in-flight run's
 * result rather than starting a competing IMAP session.
 */
let inFlight: Promise<NextResponse> | null = null;

async function authorised(req: Request): Promise<boolean> {
  const secret = process.env.INBOUND_POLL_SECRET;
  if (secret && req.headers.get("x-poll-secret") === secret) return true;
  // Fall back to a logged-in session (the in-app poll).
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return Boolean(data.user);
}

export async function POST(req: Request) {
  if (!(await authorised(req))) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }
  if (!adminConfigured()) {
    return NextResponse.json({ configured: false, processed: 0 });
  }

  if (inFlight) return (await inFlight).clone();
  const run = doPoll();
  inFlight = run;
  try {
    return (await run).clone();
  } finally {
    inFlight = null;
  }
}

async function doPoll(): Promise<NextResponse> {

  const admin = createAdminClient();

  // WHATSAPP LEDGER FIRST, and deliberately outside the IMAP guard below.
  // Reports filed over WhatsApp belong to a shared intake account nobody ever
  // logs into, so the app's own timer never sweeps them and their escalation
  // notifications never fall due. Until now the only trigger was another
  // inbound WhatsApp message, which meant a quiet ledger stalled at 'filed' —
  // exactly the failure this product exists to refuse.
  //
  // This route is the one already shaped for the job: reachable by a cron with
  // INBOUND_POLL_SECRET as well as by the open app, and both callers want the
  // same thing — the ledger moving forward without a browser. It is NOT gated
  // on Gmail, because a deployment can perfectly well take WhatsApp reports
  // without email configured, and gating it there would silently freeze them.
  // A deployment that has never seen a WhatsApp message has no intake user, so
  // this costs one indexed lookup and stops.
  let whatsapp: { swept: number; notified: number } | null = null;
  try {
    const intakeUser = await findIntakeUserId(admin);
    if (intakeUser) whatsapp = await sweepAndNotify(admin, intakeUser);
  } catch (err) {
    // Never fail the poll over this — they are independent jobs that happen to
    // share a trigger.
    console.warn("[poll] whatsapp sweep failed", err);
  }

  if (!imapConfigured()) {
    return NextResponse.json({ configured: false, processed: 0, whatsapp });
  }

  const messages = await fetchUnseen();

  let processed = 0;
  const results: { subject: string; matched: boolean; kind?: string }[] = [];

  for (const msg of messages) {
    // Match the reply back to the exact report+owner via the Message-ID we sent
    // with. No In-Reply-To → we cannot safely attribute it; leave it unread.
    if (!msg.inReplyTo) {
      results.push({ subject: msg.subject, matched: false });
      continue;
    }

    const { data: origin } = await admin
      .from("outbox_items")
      .select("user_id, report_id")
      .eq("provider_message_id", msg.inReplyTo)
      .not("report_id", "is", null)
      .limit(1)
      .maybeSingle();

    if (!origin?.user_id || !origin?.report_id) {
      results.push({ subject: msg.subject, matched: false });
      continue;
    }

    const reply: InboundReply = {
      from: msg.from,
      subject: msg.subject,
      body: msg.text,
    };

    const applied = await applyInboundReply(admin, {
      userId: origin.user_id,
      reportId: origin.report_id,
      reply,
      inReplyToMessageId: msg.messageId,
      image: msg.image,
    });

    if (applied.matched) {
      // Flag it read even when it was a duplicate: the work was already done by
      // whoever won the claim, and leaving it unread guarantees we re-enter
      // this path on every future poll.
      await markSeen(msg.uid);
      if (!applied.duplicate) processed += 1;
      results.push({
        subject: msg.subject,
        matched: true,
        kind: applied.duplicate ? `${applied.kind} (already applied)` : applied.kind,
      });
    } else {
      results.push({ subject: msg.subject, matched: false });
    }
  }
  console.log("POLL RESULTS:", { configured: true, processed, results, whatsapp });
  return NextResponse.json({ configured: true, processed, results, whatsapp });
}
