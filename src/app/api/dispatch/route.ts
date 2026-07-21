import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  gmailConfigured,
  sendMail,
  normalizeMessageId,
  type MailAttachment,
} from "@/lib/email/gmail";
import { complaintTextToHtml } from "@/lib/email/render";
import { now } from "@/lib/demoClock";

/** Fetch the redacted photo as an attachment, from a storage URL or data URL. */
async function fetchPhoto(
  photoUrl: string | null | undefined,
  reportId: string
): Promise<MailAttachment | null> {
  if (!photoUrl) return null;
  const cid = "reportphoto";
  try {
    if (photoUrl.startsWith("data:")) {
      const m = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(photoUrl);
      if (!m) return null;
      return { filename: `${reportId}.jpg`, content: Buffer.from(m[2], "base64"), contentType: m[1], cid };
    }
    const res = await fetch(photoUrl);
    if (!res.ok) return null;
    const content = Buffer.from(await res.arrayBuffer());
    return {
      filename: `${reportId}.jpg`,
      content,
      contentType: res.headers.get("content-type") ?? "image/jpeg",
      cid,
    };
  } catch {
    return null;
  }
}

/**
 * OUTBOUND DISPATCH — sends the composed complaint(s) for a report over Gmail.
 *
 * The client already composed the complaint bodies and wrote them to
 * `outbox_items` with `delivered = false`. This route (called right after
 * filing, for an instant demo) picks up that report's undelivered complaint
 * rows and actually transmits them.
 *
 * Runs as the LOGGED-IN USER via the cookie session, so RLS scopes every read
 * and write to the caller's own outbox rows — no service role needed on the
 * outbound path. (Inbound is the one that needs it; there is no session there.)
 *
 * Recipient: never the real .gov.in alias. For the demo, every authority mail
 * goes to DEMO_AUTHORITY_EMAIL so a human can play the authority and reply. The
 * real intended address stays visible as `intended_to` in the Outbox.
 *
 * Degrades like the Gemini routes: with Gmail unconfigured it returns
 * `configured: false` and sends nothing, leaving the rows as composed-not-sent.
 */

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { reportId } = await req.json().catch(() => ({ reportId: undefined }));
  if (!reportId || typeof reportId !== "string") {
    return NextResponse.json({ error: "reportId required" }, { status: 400 });
  }

  if (!gmailConfigured()) {
    return NextResponse.json({ configured: false, sent: 0 });
  }

  const demoAuthority = process.env.DEMO_AUTHORITY_EMAIL;
  if (!demoAuthority) {
    return NextResponse.json(
      { error: "DEMO_AUTHORITY_EMAIL not set" },
      { status: 500 }
    );
  }

  const supabase = await createClient();

  // RLS restricts this to the caller's own rows. Only complaints (the RTI/post
  // kinds are not real-mail in the demo), and only the ones not yet sent.
  const { data: rows, error } = await supabase
    .from("outbox_items")
    .select("id, subject, body")
    .eq("report_id", reportId)
    .eq("kind", "complaint")
    .eq("delivered", false);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!rows?.length) {
    return NextResponse.json({ configured: true, sent: 0 });
  }

  // Pull the redacted photo once and attach it inline to every complaint.
  const { data: reportRow } = await supabase
    .from("reports")
    .select("photo_url")
    .eq("id", reportId)
    .limit(1)
    .maybeSingle();
  const photo = await fetchPhoto(reportRow?.photo_url, reportId);

  let sent = 0;
  for (const row of rows) {
    try {
      const { messageId } = await sendMail({
        to: demoAuthority,
        subject: row.subject,
        text: row.body,
        html: complaintTextToHtml(row.subject, row.body, photo ? photo.cid : null),
        attachments: photo ? [photo] : [],
      });
      await supabase
        .from("outbox_items")
        .update({
          delivered: true,
          actually_to: demoAuthority,
          // Normalised (no angle brackets) so an inbound In-Reply-To matches.
          provider_message_id: normalizeMessageId(messageId),
          delivered_at: now(),
          delivery_error: null,
        })
        .eq("id", row.id);
      sent += 1;
    } catch (e) {
      const message = e instanceof Error ? e.message : "send failed";
      await supabase
        .from("outbox_items")
        .update({ delivery_error: message })
        .eq("id", row.id);
    }
  }

  return NextResponse.json({ configured: true, sent });
}
