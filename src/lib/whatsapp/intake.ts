import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import * as db from "../db";
import { fileReport, type PipelineDeps } from "../pipeline";
import { resolveAuthorityFull } from "../resolve-authority";
import { toSeverity } from "../severity";
import { analyseImage, visionConfigured, type FaceBox } from "../vision";
import { pixelateFaces } from "../redact-server";
import { stripJpegMetadata } from "../exif";
import { sendMail, gmailConfigured, normalizeMessageId } from "../email/gmail";
import { complaintTextToHtml } from "../email/render";
import { fetchReportPhoto } from "../email/photo";
import type { ProcessedImage } from "../imaging";
import type { DetectionResult } from "../detect";
import type { IssueCategory, Report } from "../types";
import { categoryLabel } from "../categories";
import { trackUrl } from "../base-url";
import { formatPlace } from "../place";
import {
  clearPending,
  getPending,
  setPending,
  withinCooldown,
  type PendingReport,
} from "./session";
import { recordNotifyTarget, sweepAndNotify, WEBHOOK_SEND_BUDGET } from "./notify";
import { hashPhone, downloadTwilioMedia } from "./twilio";

/**
 * WHATSAPP INTAKE — the civic half, with nothing Twilio-shaped in it.
 *
 * This deliberately reuses `fileReport` from `src/lib/pipeline.ts` rather than
 * reimplementing filing. That function turned out to be server-safe already: no
 * `"use client"`, and every side effect goes through injected deps. So a report
 * filed from WhatsApp travels the same code path as one filed in the app —
 * same sequence-minted id, same tiered ward routing, same SLA source, same
 * complaint text, same outbox row. If the two diverged, the WhatsApp path would
 * quietly become a second-class citizen with its own bugs.
 *
 * What could NOT be reused, and why:
 *   - `pipeline.locate()` needs navigator.geolocation. The pin supplies it.
 *   - `pipeline.resolveAuthority()` fetches a relative URL, so routing goes
 *     through `lib/resolve-authority.ts` — the same full tier chain the app
 *     resolves through, in-process, with no HTTP hop.
 *   - `store.dispatchReport()` posts to /api/dispatch, which is cookie-gated.
 *     Mail goes out inline here, the way correspondence-apply.ts already does.
 *   - `imaging.ts` (face pixelation, aHash) is canvas-bound. See stripJpegMetadata.
 */

/** One shared owner for every bot-filed report. */
const INTAKE_EMAIL = "whatsapp-intake@civicagent.local";
const INTAKE_NAME = "WhatsApp intake";

let intakeUserIdCache: string | null = null;

/**
 * `reports.user_id` is NOT NULL with a foreign key to auth.users, so a citizen
 * with no account cannot own a row. Rather than loosen that constraint, every
 * WhatsApp report belongs to one service account. Citizens still reach their
 * own report: the tracking link carries an unguessable `public_token`, which is
 * what makes the link work without a login at all.
 */
export async function getIntakeUserId(admin: SupabaseClient): Promise<string> {
  const existing = await findIntakeUserId(admin);
  if (existing) return existing;

  const { data: created, error } = await admin.auth.admin.createUser({
    email: INTAKE_EMAIL,
    email_confirm: true,
    user_metadata: { display_name: INTAKE_NAME },
  });
  if (error || !created?.user) {
    throw new Error(`Could not provision the WhatsApp intake user: ${error?.message}`);
  }
  intakeUserIdCache = created.user.id;
  return intakeUserIdCache;
}

/**
 * The intake account if it already exists, WITHOUT provisioning one.
 *
 * Separate from `getIntakeUserId` because callers that are only sweeping the
 * ledger (the inbound poll, a cron) must not conjure a user as a side effect of
 * looking: on a deployment where nobody has ever used WhatsApp, the answer is
 * "there is nothing to sweep", not "here is a new account".
 *
 * The profiles row is created by the handle_new_user trigger on signup, so it
 * is a cheap way to find the user without paging auth.users.
 */
export async function findIntakeUserId(admin: SupabaseClient): Promise<string | null> {
  if (intakeUserIdCache) return intakeUserIdCache;

  const { data } = await admin
    .from("profiles")
    .select("id")
    .eq("email", INTAKE_EMAIL)
    .maybeSingle();

  if (!data?.id) return null;
  intakeUserIdCache = data.id as string;
  return intakeUserIdCache;
}

// ------------------------------------------------------------------ replies

export const GREETING = `CivicAgent — report a civic problem in one message.

1. Send a *photo* of the problem (pothole, garbage, sewage, streetlight, drain).
2. Then share your *location*: tap the 📎 attach button → Location → Send your current location.

We identify it, work out which agency is responsible, file the complaint and give you a link to track it.`;

export const ASK_FOR_PHOTO = `Send a *photo* of the problem first, then share your location.`;

// ------------------------------------------------------------- photo step

export async function handlePhoto(
  admin: SupabaseClient,
  phone: string,
  mediaUrl: string,
  contentType: string | null,
  caption: string
): Promise<string> {
  const phoneHash = hashPhone(phone);

  const existing = await getPending(admin, phoneHash);
  if (withinCooldown(existing)) {
    return `Still working on your last photo — give it a few seconds, then share your location.`;
  }

  if (contentType && !contentType.startsWith("image/")) {
    return `That came through as ${contentType}, not a photo. Send a picture of the problem instead.`;
  }

  let media;
  try {
    media = await downloadTwilioMedia(mediaUrl);
  } catch (err) {
    console.error("[whatsapp] media download failed", err);
    return `We couldn't download that image. Please try sending it again.`;
  }

  if (!media.contentType.startsWith("image/")) {
    return `That doesn't look like a photo. Send a picture of the problem instead.`;
  }

  // EXIF first, on the raw bytes.
  const cleaned =
    media.contentType === "image/jpeg" ? stripJpegMetadata(media.bytes) : media.bytes;

  // CLASSIFY BEFORE STORING. The order matters: the same Gemini call that
  // identifies the defect also returns face boxes, and we want the unredacted
  // original never to reach the bucket at all. It used to upload first and
  // classify second, which stored the raw frame and then had nothing to do
  // about it.
  let category: IssueCategory = "other";
  let severity: PendingReport["severity"] = "moderate";
  let confidence = 0;
  let reason = "";
  let note = "";
  let faces: FaceBox[] = [];
  let visionRan = false;

  if (visionConfigured()) {
    const dataUrl = `data:${media.contentType};base64,${Buffer.from(cleaned).toString("base64")}`;
    const analysis = await analyseImage(dataUrl);
    if (analysis.ok) {
      visionRan = true;
      category = analysis.category;
      severity = analysis.severity;
      confidence = analysis.confidence;
      reason = analysis.reason;
      faces = analysis.faces;
    } else if (analysis.kind === "rateLimited") {
      note = `

(Our image AI is rate-limited right now, so the category is unconfirmed and faces were NOT blurred.)`;
    } else {
      note = `

(We couldn't auto-identify it, so the category is unconfirmed and faces were NOT blurred.)`;
    }
  } else {
    note = `

(Image AI isn't configured, so the category is unconfirmed and faces were NOT blurred.)`;
  }

  // Redact server-side. Weaker than the app's on-device pass — the original did
  // reach our server — but it happens before the photo is stored, mailed to an
  // authority or published on the public ledger, which is what actually matters
  // to the person standing in the road.
  const redacted = await pixelateFaces(cleaned, faces);
  const facesBlurred = redacted.facesBlurred;
  if (faces.length && !redacted.ok) {
    console.error("[whatsapp] faces were detected but pixelation failed — storing unredacted");
  }

  const intakeUserId = await getIntakeUserId(admin);
  // pixelateFaces re-encodes as JPEG, so the stored type follows what we
  // actually produced rather than what arrived.
  const outType = facesBlurred > 0 ? "image/jpeg" : media.contentType;
  const ext = outType === "image/png" ? "png" : "jpg";
  // A pending key, because there is no report id yet — one is minted only once
  // the location arrives and the report is actually filed.
  const path = `${intakeUserId}/pending-${crypto.randomUUID()}.${ext}`;

  const { error: upErr } = await admin.storage
    .from("report-photos")
    .upload(path, redacted.bytes, { contentType: outType, upsert: true });
  if (upErr) {
    console.error("[whatsapp] photo upload failed", upErr);
    return `We couldn't save that photo. Please try again in a moment.`;
  }
  const photoUrl = admin.storage.from("report-photos").getPublicUrl(path).data.publicUrl;

  if (visionRan) {
    note +=
      facesBlurred > 0
        ? `

🔒 ${facesBlurred} face(s) blurred before your photo was stored.`
        : `

🔒 No faces detected, so nothing was blurred.`;
  }

  await setPending(admin, {
    phoneHash,
    photoUrl,
    photoPath: path,
    caption,
    category,
    severity,
    categoryConfidence: confidence,
    reason,
    facesBlurred,
  });

  const what =
    confidence > 0
      ? `Looks like *${categoryLabel(category)}*${reason ? ` — ${reason}` : ""}.`
      : `Photo received.`;

  return `${what}${note}

Now share your *location* so we know which ward to file it in:
tap 📎 → Location → *Send your current location*.`;
}

// ---------------------------------------------------------- location step

export interface FiledResult {
  reply: string;
  report?: Report;
}

export async function handleLocation(
  admin: SupabaseClient,
  phone: string,
  lat: number,
  lng: number
): Promise<FiledResult> {
  const phoneHash = hashPhone(phone);
  const pending = await getPending(admin, phoneHash);
  if (!pending) return { reply: ASK_FOR_PHOTO };

  const intakeUserId = await getIntakeUserId(admin);

  // The FULL tier chain, identical to what the app resolves through. This used
  // to call the spatial lib directly, which only implements Tiers 1-2 and
  // returns no authorities outside the Chennai ward polygons — so every report
  // from elsewhere was refused here while the same photo filed fine in the app.
  const outcome = await resolveAuthorityFull(lat, lng, pending.category);

  if (!outcome.ok) {
    // Only reachable if the spatial resolver itself failed (e.g. the ward
    // GeoJSON is missing). The chain otherwise always yields a Tier 4 fallback.
    return {
      reply: `Our location service is down for a moment, so we haven't filed this yet.

Your photo is saved — reply with your location again in a minute.`,
    };
  }

  const { routing, authorities, ms: resolveMs } = outcome;

  // fileReport only reads dataUrl, aHash, facesFound and bytes off the image.
  // aHash stays empty: the perceptual hash needs canvas, so hash-based
  // duplicate detection does not apply to this path (geographic dedup still
  // does, in the app).
  const image: ProcessedImage = {
    dataUrl: pending.photoUrl,
    width: 0,
    height: 0,
    aHash: "",
    // Real numbers now: faces were pixelated server-side at photo time, so the
    // complaint email can state what happened instead of assuming.
    facesFound: pending.facesBlurred,
    // The WhatsApp path redacts faces server-side only (see redact-server.ts);
    // number-plate redaction is browser-Report-only for now.
    platesFound: 0,
    manualReviewRequired: false,
    bytes: 0,
    faceRegions: [],
    plateRegions: [],
  };

  const detection: DetectionResult = {
    severity: toSeverity(pending.severity),
    confidence: pending.categoryConfidence,
    areaFraction: 0,
    signals: [
      `Submitted over WhatsApp — EXIF stripped and ${pending.facesBlurred} face(s) pixelated server-side (not on the sender's device)`,
      pending.reason ? `Gemini: ${pending.reason}` : `Category unconfirmed by vision`,
    ],
    lowConfidence: pending.categoryConfidence < 0.45,
    method: "heuristic-v1",
  };

  const deps: PipelineDeps = {
    pushTrace: (line) => console.log(`[whatsapp trace] ${line.agent}: ${line.text}`),
    mintId: () => db.mintReportId(admin),
    // The photo is already in storage under a pending key; hand back that URL
    // rather than re-uploading the bytes we no longer hold.
    uploadPhoto: async () => pending.photoUrl,
    addReport: (r) => db.insertReport(admin, r, intakeUserId),
    pushOutbox: (items) => db.insertOutbox(admin, items, intakeUserId),
  };

  const report = await fileReport(deps, {
    image,
    detection,
    category: pending.category,
    categorySource: pending.categoryConfidence > 0 ? "model" : "heuristic",
    categoryConfidence: pending.categoryConfidence,
    fix: { lat, lng, exact: true },
    routing,
    authorities,
    resolveMs,
    // Drives the redaction sentence in the complaint body. A WhatsApp photo
    // reaches our server unredacted, so the email must not claim otherwise.
    source: "whatsapp",
  });

  // `source` is not part of reportToRow, and public_token is generated by the
  // database — so stamp one and read back the other in a single round trip.
  const { data: stamped, error: stampErr } = await admin
    .from("reports")
    .update({ source: "whatsapp" })
    .eq("user_id", intakeUserId)
    .eq("id", report.id)
    .select("public_token")
    .single();
  if (stampErr) console.error("[whatsapp] could not stamp source/read token", stampErr);

  await clearPending(admin, phoneHash);

  // Remember where to reach this citizen. Until now the raw number was
  // deliberately never persisted (sessions are keyed by its hash), but a hash
  // cannot be messaged and `claims_done` is a state the loop cannot leave
  // without them. Bounded and deleted on closure — see lib/whatsapp/notify.ts.
  await recordNotifyTarget(admin, intakeUserId, report.id, phone);

  await dispatchComplaints(admin, intakeUserId, report.id);
  // Every inbound message nudges the whole intake ledger forward and sends any
  // notification that fell due. A small send budget because a citizen is
  // waiting on this reply and Twilio gives up after 15s — see notify.ts.
  await sweepAndNotify(admin, intakeUserId, WEBHOOK_SEND_BUDGET);

  const token = stamped?.public_token as string | undefined;
  // Shared with the app so the WhatsApp reply names a place the same way the
  // report sheet does — and so a ward-less Tier 2 fix still says the locality
  // rather than falling all the way back to the city.
  const where = formatPlace(routing, { lat, lng });
  const deadline = new Date(report.slaDeadline).toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  });
  const unverified = authorities.some((a) => !a.verified);

  const lines = [
    `✅ Filed as *${report.id}* — ${categoryLabel(report.category)}, severity ${report.severity}.`,
    ``,
    `📍 ${where}`,
    `🏛 Filed to: ${report.filedTo.join(", ")}`,
    `⏱ Deadline: ${deadline}`,
  ];
  // Say how confident the routing is, rather than presenting a Tier 4 guess
  // with the same certainty as a ward-polygon match. The authority record is
  // already flagged unverified everywhere else; the reply should agree.
  if (unverified) {
    lines.push(
      ``,
      routing.tier === 3
        ? `⚠️ We don't hold a verified contact for this area, so the department above was identified by AI and is unconfirmed.`
        : `⚠️ We don't hold a verified contact for this area, so this went to the general municipal office. Unconfirmed.`
    );
  }
  if (token) lines.push(``, `Track it here:`, trackUrl(token));
  lines.push(
    ``,
    `We'll message you here when the agency responds. This closes only on an after-photo showing the problem gone — you can send one from the link above at any time.`
  );

  return { reply: lines.join("\n"), report };
}

/**
 * Sends the composed complaints for a report.
 *
 * /api/dispatch does this for the app, but it runs as the logged-in user and is
 * RLS-scoped, so a webhook cannot call it. Same work, service-role client,
 * inline — following correspondence-apply.ts.
 */
async function dispatchComplaints(
  admin: SupabaseClient,
  userId: string,
  reportId: string
): Promise<void> {
  if (!gmailConfigured()) return;
  const sink = process.env.DEMO_AUTHORITY_EMAIL;
  if (!sink) {
    console.warn("[whatsapp] DEMO_AUTHORITY_EMAIL not set — complaint not sent");
    return;
  }

  const { data: rows, error } = await admin
    .from("outbox_items")
    .select("id, subject, body, intended_to")
    .eq("user_id", userId)
    .eq("report_id", reportId)
    .eq("kind", "complaint")
    .eq("delivered", false);
  if (error || !rows?.length) return;

  // ATTACH THE PHOTO. /api/dispatch has always done this for reports filed in
  // the app; this path did not, so every WhatsApp complaint arrived at the
  // authority announcing an attached photograph and carrying none — a civic
  // complaint with the evidence removed. Fetched once for all recipients.
  const { data: reportRow } = await admin
    .from("reports")
    .select("photo_url")
    .eq("user_id", userId)
    .eq("id", reportId)
    .maybeSingle();
  const photo = await fetchReportPhoto(reportRow?.photo_url, reportId);
  if (!photo) console.warn(`[whatsapp] no photo attached to the complaint for ${reportId}`);

  for (const row of rows) {
    try {
      const result = await sendMail({
        to: sink,
        subject: row.subject,
        text: row.body,
        html: complaintTextToHtml(row.subject, row.body, photo ? photo.cid : null),
        attachments: photo ? [photo] : [],
      });
      await admin
        .from("outbox_items")
        .update({
          delivered: true,
          actually_to: sink,
          provider_message_id: normalizeMessageId(result.messageId),
          delivered_at: Date.now(),
          delivery_error: null,
        })
        .eq("id", row.id);
    } catch (err) {
      console.error("[whatsapp] complaint send failed", err);
      await admin
        .from("outbox_items")
        .update({ delivery_error: err instanceof Error ? err.message : "send failed" })
        .eq("id", row.id);
    }
  }
}
