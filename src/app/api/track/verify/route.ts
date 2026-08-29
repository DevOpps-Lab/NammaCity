import { NextResponse } from "next/server";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { fetchReportByToken, verifyAndClose } from "@/lib/db";
import { verifyAfterPhoto } from "@/lib/verify-vision";
import { composeUpdate } from "@/lib/escalation";
import { notifyStatus } from "@/lib/whatsapp/notify";
import { now } from "@/lib/demoClock";

/**
 * CLOSING A REPORT FROM THE TRACKING LINK
 *
 * A citizen who filed over WhatsApp has no account, so every closing path in
 * the app was out of reach to them: `verify_and_close` needs an owner, and the
 * only owner their report has is the shared intake account nobody logs into.
 * The result was a report the filer could watch but never finish — while the
 * product's central claim is that a report closes on a citizen's after-photo.
 * This route is that photo's way in.
 *
 * WHAT AUTHORISES THE CALL. The `public_token` and nothing else. It is a uuid,
 * unguessable, and was delivered to exactly one phone. But it is also a bearer
 * credential printed in a chat message and the tracking page says out loud that
 * anyone with the link can view the report — so the token is treated as proof
 * of "I was given this link", never as proof of identity.
 *
 * WHICH IS WHY THE VISION CHECK IS MANDATORY HERE. In the app, a signed-in
 * resident may confirm their own after-photo manually when Gemini is absent or
 * unsure (store.ts#confirmFixed). A bare token-holder may not: closure through
 * this route requires `verifyAfterPhoto` to be configured AND to return
 * `likely_repaired` — same place, defect gone. That is deliberately stricter
 * than the in-app path and is exactly the rule the authority-photo close
 * already follows in correspondence-apply.ts, so the two anonymous-ish closing
 * paths cannot drift apart. No vision, no close; a photo of somewhere else, no
 * close. The DB floor (`verify_and_close` refusing a null photo) is below both.
 */

export const runtime = "nodejs";

/** The bucket's own ceiling (0002_storage.sql). Refuse before decoding. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/;

/**
 * Per-token throttle.
 *
 * This is a public endpoint whose body is a multi-megabyte image and whose work
 * is a Gemini call plus a storage write — the most expensive unauthenticated
 * request in the codebase. In-memory and therefore per-instance: it is a brake
 * on a stuck client or a bored tester, not a defence against a distributed
 * attacker, and it is honest to say so rather than to imply the endpoint is
 * rate-limited in any meaningful sense. Real protection belongs at the edge
 * (Vercel WAF / BotID) if this ever leaves the demo.
 */
const ATTEMPT_WINDOW_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS_PER_WINDOW = 6;
const MIN_GAP_MS = 15_000;
const attempts = new Map<string, number[]>();

function throttled(token: string): string | null {
  const at = now();
  const recent = (attempts.get(token) ?? []).filter((t) => at - t < ATTEMPT_WINDOW_MS);

  if (recent.length && at - recent[recent.length - 1] < MIN_GAP_MS) {
    return "Give it a few seconds before trying again.";
  }
  if (recent.length >= MAX_ATTEMPTS_PER_WINDOW) {
    return "Too many attempts on this report. Try again later.";
  }

  recent.push(at);
  attempts.set(token, recent);
  // Bound the map: without this, one token per visitor accumulates forever in a
  // long-lived Fluid Compute instance.
  if (attempts.size > 500) {
    for (const [key, times] of attempts) {
      if (!times.some((t) => at - t < ATTEMPT_WINDOW_MS)) attempts.delete(key);
    }
  }
  return null;
}

export interface TrackVerifyResponse {
  closed: boolean;
  /** Machine-readable outcome, so the UI does not parse prose. */
  reason:
    | "closed"
    | "already_closed"
    | "unconfigured"
    | "rate_limited"
    | "wrong_place"
    | "still_present"
    | "vision_error";
  headline: string;
  detail: string;
  verdict?: string;
  placeMatch?: number;
  defectResolved?: number;
}

function say(
  status: number,
  body: TrackVerifyResponse
): NextResponse<TrackVerifyResponse> {
  return NextResponse.json(body, { status });
}

export async function POST(request: Request) {
  let token: unknown, afterDataUrl: unknown;
  try {
    ({ token, afterDataUrl } = await request.json());
  } catch {
    return NextResponse.json({ error: "Malformed body" }, { status: 400 });
  }

  if (typeof token !== "string" || !/^[0-9a-f-]{36}$/i.test(token)) {
    return NextResponse.json({ error: "Bad token" }, { status: 400 });
  }
  if (typeof afterDataUrl !== "string") {
    return NextResponse.json({ error: "afterDataUrl required" }, { status: 400 });
  }

  const match = ALLOWED.exec(afterDataUrl);
  if (!match) {
    return NextResponse.json(
      { error: "Send a JPEG, PNG or WebP photo." },
      { status: 415 }
    );
  }
  const [, mimeType, base64] = match;
  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: "That photo is too large (5MB max)." }, { status: 413 });
  }

  const brake = throttled(token);
  if (brake) {
    return say(429, {
      closed: false,
      reason: "rate_limited",
      headline: "Slow down a moment",
      detail: brake,
    });
  }

  if (!adminConfigured()) {
    return say(200, {
      closed: false,
      reason: "unconfigured",
      headline: "Verification isn't available",
      detail: "This deployment isn't fully configured. Nothing was changed.",
    });
  }

  const admin = createAdminClient();
  // The token is scoped into the query itself — nothing else from the URL or
  // body ever reaches a filter.
  const report = await fetchReportByToken(admin, token);
  if (!report) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (report.status === "verified_fixed") {
    return say(200, {
      closed: false,
      reason: "already_closed",
      headline: "Already closed",
      detail: "This report has already been verified fixed.",
    });
  }

  const check = await verifyAfterPhoto({
    afterDataUrl,
    beforeUrl: report.photoUrl,
    category: report.category,
  });

  // No vision, no close. Unlike the app there is no manual-confirm fallback
  // here, because there is no identity behind this request to stand behind one.
  if (!check.configured) {
    return say(200, {
      closed: false,
      reason: "unconfigured",
      headline: "We can't check the photo right now",
      detail:
        "Photo verification isn't configured on this deployment, and we won't close a report without it. Your report is unchanged and the clock is still running.",
    });
  }
  if (check.rateLimited) {
    return say(200, {
      closed: false,
      reason: "rate_limited",
      headline: "Our image check is busy",
      detail: "Please try again in a minute. Nothing was changed.",
    });
  }
  if (check.error || !check.verdict) {
    return say(200, {
      closed: false,
      reason: "vision_error",
      headline: "We couldn't read that photo",
      detail: "Try a clearer shot of the same spot. Nothing was changed.",
    });
  }

  if (check.verdict !== "likely_repaired") {
    const wrongPlace = check.verdict === "inconclusive";
    return say(200, {
      closed: false,
      reason: wrongPlace ? "wrong_place" : "still_present",
      headline: wrongPlace
        ? "This doesn't look like the same place"
        : "The problem still looks like it's there",
      detail: wrongPlace
        ? // The documented fraud is a closure photographed somewhere else, so
          // this refusal is the product working, not failing.
          `We compare the after-photo with the original. ${check.reason ?? "The two scenes don't match."} Nothing was changed — take the photo from roughly where the first one was taken.`
        : `${check.reason ?? "The defect is still visible."} The report stays open and the clock keeps running.`,
      verdict: check.verdict,
      placeMatch: check.placeMatch,
      defectResolved: check.defectResolved,
    });
  }

  // --- verified: store the photo and close ---------------------------------
  const owner = report.ownerId;
  if (!owner) {
    return say(200, {
      closed: false,
      reason: "vision_error",
      headline: "We couldn't close this report",
      detail: "Something is wrong with this report's record. Nothing was changed.",
    });
  }

  const ext = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
  const path = `${owner}/${report.id}-after-${now()}.${ext}`;
  const { error: upErr } = await admin.storage
    .from("report-photos")
    .upload(path, bytes, { contentType: mimeType, upsert: true });
  if (upErr) {
    console.error("[track] after-photo upload failed", upErr);
    return say(502, {
      closed: false,
      reason: "vision_error",
      headline: "We couldn't save that photo",
      detail: "The check passed but saving failed. Please try again in a moment.",
    });
  }
  const afterUrl = admin.storage.from("report-photos").getPublicUrl(path).data.publicUrl;

  const closed = await verifyAndClose(admin, {
    owner,
    reportId: report.id,
    afterUrl,
    // Named for what we actually know: someone holding the tracking link, whose
    // photo passed the check. Not "the citizen who filed it" — we cannot know
    // that from a bearer token, and the closure record should not claim to.
    source: "a resident, from the tracking link (photo auto-verified)",
    now: now(),
  });

  if (!closed) {
    return say(200, {
      closed: false,
      reason: "already_closed",
      headline: "Already closed",
      detail: "Someone verified this report just before you did.",
    });
  }

  // Announce it, and tell the filer over WhatsApp. Both best-effort: the
  // closure is already durable in Postgres and must not be undone by a failure
  // to talk about it.
  try {
    await admin.from("public_posts").insert({
      report_id: report.id,
      kind: "update",
      body: composeUpdate({ ...report, status: "verified_fixed" }).text,
      source: "simulated",
      author: owner,
      at: now(),
    });
  } catch (err) {
    console.warn("[track] public post failed", err);
  }
  try {
    await notifyStatus(admin, { owner, reportId: report.id, kind: "verified_fixed" });
  } catch (err) {
    console.warn("[track] closing notification failed", err);
  }

  return say(200, {
    closed: true,
    reason: "closed",
    headline: "Verified — this report is closed",
    detail:
      check.reason ??
      "The after-photo matches the original location and the defect is gone.",
    verdict: check.verdict,
    placeMatch: check.placeMatch,
    defectResolved: check.defectResolved,
  });
}
