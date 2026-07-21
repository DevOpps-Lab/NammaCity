import nodemailer, { type Transporter } from "nodemailer";

/**
 * GMAIL SMTP SEND. SERVER-ONLY, Node runtime.
 *
 * One Gmail App Password on GMAIL_USER unlocks both this (SMTP send) and the
 * inbound IMAP poll (`./inbound.ts`) — chosen over Resend/Postmark because those
 * need a verified custom domain to RECEIVE, and the demo runs entirely on Gmail
 * addresses. App Password requires 2FA:
 * https://myaccount.google.com/apppasswords
 *
 * Every send is FROM GMAIL_USER (nammachennaidev). For the demo, the recipient
 * is always the DEMO_AUTHORITY_EMAIL — no mail ever reaches a real .gov.in
 * address. The caller decides the `to`; this module only knows how to send.
 */

export function gmailConfigured(): boolean {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

let transport: Transporter | null = null;

function getTransport(): Transporter {
  if (typeof window !== "undefined") {
    throw new Error("gmail.ts must never run in the browser.");
  }
  if (transport) return transport;
  transport = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER!,
      pass: process.env.GMAIL_APP_PASSWORD!,
    },
  });
  return transport;
}

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
  /** Content-ID for inline embedding, referenced as `cid:<id>` in the HTML. */
  cid?: string;
}

export interface SendInput {
  to: string;
  subject: string;
  /** Plain-text body — the composed complaint/reply is already plain text. */
  text: string;
  /** Optional HTML body. When present, clients render this and fall back to text. */
  html?: string;
  attachments?: MailAttachment[];
  /**
   * The Message-ID of the mail we are replying to, for `In-Reply-To` /
   * `References` so the authority's client threads it — and so their reply
   * carries it back to us for matching.
   */
  inReplyTo?: string;
}

export interface SendResult {
  /** The RFC Message-ID this mail was sent with. Stored for inbound matching. */
  messageId: string;
}

export async function sendMail(input: SendInput): Promise<SendResult> {
  if (!gmailConfigured()) {
    throw new Error("Gmail is not configured (GMAIL_USER / GMAIL_APP_PASSWORD).");
  }

  const info = await getTransport().sendMail({
    from: `CivicAgent <${process.env.GMAIL_USER!}>`,
    to: input.to,
    subject: input.subject,
    text: input.text,
    ...(input.html ? { html: input.html } : {}),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    ...(input.inReplyTo
      ? { inReplyTo: input.inReplyTo, references: input.inReplyTo }
      : {}),
  });

  return { messageId: info.messageId };
}

/** Normalise a Message-ID for comparison (strip angle brackets / whitespace). */
export function normalizeMessageId(id: string | null | undefined): string {
  return (id ?? "").trim().replace(/^<|>$/g, "");
}
