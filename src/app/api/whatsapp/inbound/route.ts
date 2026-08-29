import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import {
  ASK_FOR_PHOTO,
  GREETING,
  handleLocation,
  handlePhoto,
} from "@/lib/whatsapp/intake";
import {
  parseTwilioMessage,
  signedUrlFor,
  twiml,
  twilioConfigured,
  verifyTwilioSignature,
} from "@/lib/whatsapp/twilio";

/**
 * WHATSAPP INBOUND WEBHOOK (Twilio Sandbox)
 *
 * A citizen sends a photo, then a location pin, and gets back a filed report id
 * with a tracking link. The report travels the same pipeline as one filed in
 * the app — see src/lib/whatsapp/intake.ts.
 *
 * Two things to know before editing:
 *
 * 1. This route only works because `/api/whatsapp` is in PUBLIC_PATHS in
 *    src/proxy.ts. Twilio sends no cookies, and the proxy 307s unauthenticated
 *    requests to /login — which would hand Twilio an HTML login page instead of
 *    TwiML. That is exactly how the original stub failed.
 *
 * 2. Being public makes this the one endpoint where an unauthenticated request
 *    writes to the database and sends mail, so the Twilio signature check is
 *    load-bearing. It fails CLOSED: a bad or missing signature is rejected.
 *
 * Replies are TwiML in the response body, so no outbound Twilio API call is
 * needed for the conversation.
 */

export const runtime = "nodejs";

export async function POST(request: Request) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  // No token means nothing can be verified, so nothing is accepted. Fail closed
  // rather than serve an unauthenticated write endpoint.
  if (!authToken) {
    console.warn("[whatsapp] webhook hit but TWILIO_AUTH_TOKEN is not set");
    return new Response("Forbidden", { status: 403 });
  }

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(await request.text());
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  // Deliberately BEFORE any other check, including whether the rest of the
  // integration is configured: an unsigned caller learns nothing about this
  // deployment, not even its configuration state.
  if (
    !verifyTwilioSignature(
      signedUrlFor(request),
      params,
      request.headers.get("x-twilio-signature"),
      authToken
    )
  ) {
    console.warn("[whatsapp] rejected a request with an invalid X-Twilio-Signature");
    return new Response("Forbidden", { status: 403 });
  }

  // Past this point the caller is Twilio. Degrade with an explanation the way
  // the rest of the app does (adminConfigured, gmailConfigured) rather than
  // 500ing at an integration that was never finished being set up.
  if (!twilioConfigured() || !adminConfigured()) {
    console.warn("[whatsapp] TWILIO_ACCOUNT_SID or SUPABASE_SERVICE_ROLE_KEY missing");
    return twiml(
      "NammaCity's WhatsApp intake isn't fully configured yet. Please try the app instead."
    );
  }

  const msg = parseTwilioMessage(params);
  if (!msg.from) return new Response("Bad Request", { status: 400 });

  try {
    const admin = createAdminClient();

    // Order matters: a single message carries either media or a location, and
    // media is checked first so a photo with a caption is treated as a photo.
    if (msg.mediaUrl) {
      return twiml(
        await handlePhoto(admin, msg.from, msg.mediaUrl, msg.mediaContentType, msg.body)
      );
    }

    if (msg.lat !== null && msg.lng !== null) {
      const { reply } = await handleLocation(admin, msg.from, msg.lat, msg.lng);
      return twiml(reply);
    }

    // Any text at all gets the instructions; there is no command surface to
    // learn, which is the point of the channel.
    return twiml(msg.body ? GREETING : ASK_FOR_PHOTO);
  } catch (error) {
    // Never leak an internal message to a citizen, but do not go silent either
    // — a bare 500 shows up in WhatsApp as nothing at all.
    //
    // Unwrapped deliberately: an Error passed as an object logs as `{}` through
    // a JSON logger, and `{}` is worthless on the one path that costs a citizen
    // their filed report. Message and stack, or the raw value if it is neither.
    console.error(
      "[whatsapp] intake failed:",
      error instanceof Error ? `${error.message}\n${error.stack}` : JSON.stringify(error)
    );
    return twiml(
      "Something went wrong on our side and your report wasn't filed. Please try again in a moment."
    );
  }
}

/**
 * Twilio does not verify webhooks with a GET, but hitting the URL in a browser
 * is the first thing anyone does when wiring this up. Answer usefully instead
 * of with a 405.
 */
export async function GET() {
  return Response.json({
    ok: true,
    endpoint: "whatsapp inbound webhook",
    configured: twilioConfigured() && adminConfigured(),
    expects: "Twilio form-encoded POST with a valid X-Twilio-Signature",
  });
}
