import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { normalizeMessageId } from "./gmail";

/**
 * GMAIL IMAP READ. SERVER-ONLY, Node runtime.
 *
 * Polls the GMAIL_USER inbox for unseen authority replies. Same App Password as
 * the SMTP send in `./gmail.ts`. We parse each raw message with mailparser
 * rather than hand-rolling MIME extraction — real Gmail replies are multipart,
 * carry quoted history and an HTML alternative, and mailparser gives us the
 * clean plain-text body plus the `In-Reply-To` header we thread on.
 */

export interface InboundMessage {
  /** IMAP UID, used to flag the message \Seen once processed. */
  uid: number;
  from: string;
  subject: string;
  /** Plain-text body (quoted history included; the classifier keys on phrases). */
  text: string;
  /** Message-ID of the mail this replies to, normalised (no angle brackets). */
  inReplyTo: string;
  /** This message's own Message-ID, so our auto-response can thread onto it. */
  messageId: string;
  /** First inline image attachment, if any — used to verify an authority's "done" claim. */
  image: { content: Buffer; mimeType: string } | null;
}

export function imapConfigured(): boolean {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

function makeClient(): ImapFlow {
  return new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: {
      user: process.env.GMAIL_USER!,
      pass: process.env.GMAIL_APP_PASSWORD!,
    },
    logger: false,
  });
}

/** Fetch all unseen messages in the inbox. Does NOT mark them seen. */
export async function fetchUnseen(): Promise<InboundMessage[]> {
  if (typeof window !== "undefined") {
    throw new Error("inbound.ts must never run in the browser.");
  }
  const client = makeClient();
  const out: InboundMessage[] = [];

  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    for await (const msg of client.fetch(
      { seen: false },
      { uid: true, source: true }
    )) {
      if (!msg.source) continue;
      const parsed = await simpleParser(msg.source);
      const inReplyToRaw = Array.isArray(parsed.inReplyTo)
        ? parsed.inReplyTo[0]
        : parsed.inReplyTo;
      const imageAtt = (parsed.attachments ?? []).find((a) =>
        (a.contentType ?? "").startsWith("image/")
      );
      out.push({
        uid: msg.uid,
        from: parsed.from?.text ?? "",
        subject: parsed.subject ?? "",
        text: parsed.text ?? "",
        inReplyTo: normalizeMessageId(inReplyToRaw),
        messageId: normalizeMessageId(parsed.messageId),
        image: imageAtt
          ? { content: imageAtt.content as Buffer, mimeType: imageAtt.contentType || "image/jpeg" }
          : null,
      });
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }

  return out;
}

/** Flag a processed message \Seen so a later poll never reprocesses it. */
export async function markSeen(uid: number): Promise<void> {
  const client = makeClient();
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    await client.messageFlagsAdd({ uid: String(uid) }, ["\\Seen"], { uid: true });
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}
