import crypto from "node:crypto";

/**
 * TWILIO EDGE — everything provider-specific about the WhatsApp webhook.
 *
 * The Twilio Sandbox posts `application/x-www-form-urlencoded` (the same shape
 * as inbound SMS) and accepts a TwiML document as the response body, which is
 * why this integration needs no outbound API call to reply.
 *
 * Kept separate from `intake.ts` so the civic logic does not know what a
 * `MediaUrl0` is. Adding Meta's Cloud API later means another adapter here, not
 * a rewrite of the filing flow.
 */

export interface TwilioMessage {
  /** E.164, `whatsapp:` prefix removed. */
  from: string;
  body: string;
  mediaUrl: string | null;
  mediaContentType: string | null;
  lat: number | null;
  lng: number | null;
  /** Twilio's own address label for a shared pin, when present. */
  address: string | null;
}

export function twilioConfigured(): boolean {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
}

export function parseTwilioMessage(params: URLSearchParams): TwilioMessage {
  const num = (v: string | null) => {
    if (v === null || v.trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    from: (params.get("From") ?? "").replace(/^whatsapp:/, "").trim(),
    body: (params.get("Body") ?? "").trim(),
    mediaUrl: params.get("MediaUrl0"),
    mediaContentType: params.get("MediaContentType0"),
    lat: num(params.get("Latitude")),
    lng: num(params.get("Longitude")),
    address: params.get("Address"),
  };
}

/**
 * Verifies `X-Twilio-Signature`.
 *
 * Twilio's scheme: take the full request URL, append every POST parameter as
 * `name + value` with no delimiters in case-sensitive alphabetical order by
 * name, HMAC-SHA1 it with the auth token, base64 the digest.
 *
 * This endpoint is publicly reachable by necessity — it is the one route that
 * has to accept a request with no session — so it is the one place in this
 * codebase where an unauthenticated POST causes database writes and outbound
 * email. That makes verification load-bearing, not decorative.
 */
export function verifyTwilioSignature(
  url: string,
  params: URLSearchParams,
  signature: string | null,
  authToken: string
): boolean {
  if (!signature) return false;

  const names = [...new Set([...params.keys()])].sort();
  let data = url;
  for (const name of names) {
    // getAll: a repeated key must contribute every value, in order.
    for (const value of params.getAll(name)) data += name + value;
  }

  const expected = crypto
    .createHmac("sha1", authToken)
    .update(Buffer.from(data, "utf8"))
    .digest("base64");

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  // timingSafeEqual throws on a length mismatch, so guard first.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * The URL Twilio signed is the one it was configured with, which is not
 * necessarily what `request.url` says behind a proxy: Vercel terminates TLS, so
 * an incoming request can present as http:// internally. Prefer the forwarded
 * headers, and allow an explicit override for tunnels during development.
 */
export function signedUrlFor(request: Request): string {
  const explicit = process.env.TWILIO_WEBHOOK_URL;
  if (explicit) return explicit;

  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto");
  if (host) url.host = host;
  if (proto) url.protocol = `${proto}:`;
  // Twilio signs the URL exactly as configured — without a query string here.
  url.search = "";
  return url.toString();
}

/** Bucket limit is 5MB (0002_storage.sql); refuse before downloading more. */
export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;

export interface DownloadedMedia {
  bytes: Uint8Array;
  contentType: string;
}

/**
 * Fetches the media Twilio is holding for us. Requires Basic auth with the
 * account credentials; the URL 302s to blob storage, which fetch follows.
 */
export async function downloadTwilioMedia(mediaUrl: string): Promise<DownloadedMedia> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error("Twilio credentials are not configured.");

  const res = await fetch(mediaUrl, {
    headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` },
  });
  if (!res.ok) throw new Error(`Media fetch failed: ${res.status} ${res.statusText}`);

  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_MEDIA_BYTES) {
    throw new Error(`Media too large: ${declared} bytes`);
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  // Re-check: content-length can be absent or wrong.
  if (bytes.byteLength > MAX_MEDIA_BYTES) {
    throw new Error(`Media too large: ${bytes.byteLength} bytes`);
  }

  return {
    bytes,
    contentType: (res.headers.get("content-type") ?? "application/octet-stream")
      .split(";")[0]
      .trim(),
  };
}

/** XML text escaping. A caption echoed into TwiML could otherwise break it. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * A TwiML reply. Note real newlines — the previous stub emitted the literal
 * two characters `\n` into WhatsApp because they were escaped twice.
 */
export function twiml(message: string): Response {
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Message>${escapeXml(message)}</Message></Response>`;
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

/** Twilio treats an empty <Response/> as "understood, say nothing". */
export function twimlSilent(): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<Response/>`, {
    status: 200,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

/** Sessions are keyed by this, never by the raw number. */
export function hashPhone(phone: string): string {
  return crypto.createHash("sha256").update(phone).digest("hex");
}
