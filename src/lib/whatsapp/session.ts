import type { SupabaseClient } from "@supabase/supabase-js";
import type { IssueCategory } from "../types";
import type { LLMSeverity } from "../vision";

/**
 * The half-finished report, held between two WhatsApp messages.
 *
 * A WhatsApp photo carries no GPS — location arrives as a separate message — so
 * filing cannot be a single request. The photo is uploaded and classified
 * immediately (so the second step is fast and the citizen is not left waiting
 * on a vision call after sharing their location), and the result parks here.
 *
 * Rows are keyed by a SHA-256 of the phone number and deleted as soon as the
 * report is filed. Twilio re-sends the sender on every request, so the raw
 * number is never needed beyond the lifetime of one request.
 *
 * The table has RLS enabled and no policies (0009_whatsapp_intake.sql): only
 * the service-role client can read or write it.
 */

export interface PendingReport {
  phoneHash: string;
  photoUrl: string;
  photoPath: string;
  caption: string;
  category: IssueCategory;
  severity: LLMSeverity;
  categoryConfidence: number;
  reason: string;
  updatedAt: number;
}

const TABLE = "whatsapp_sessions";

export async function getPending(
  db: SupabaseClient,
  phoneHash: string
): Promise<PendingReport | null> {
  const { data, error } = await db
    .from(TABLE)
    .select("*")
    .eq("phone_hash", phoneHash)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    phoneHash: data.phone_hash,
    photoUrl: data.photo_url,
    photoPath: data.photo_path,
    caption: data.caption ?? "",
    category: data.category as IssueCategory,
    severity: data.severity as LLMSeverity,
    categoryConfidence: data.category_confidence ?? 0,
    reason: data.reason ?? "",
    updatedAt: new Date(data.updated_at).getTime(),
  };
}

/** Upsert, so a citizen who sends a second photo replaces the first. */
export async function setPending(
  db: SupabaseClient,
  pending: Omit<PendingReport, "updatedAt">
): Promise<void> {
  const { error } = await db.from(TABLE).upsert(
    {
      phone_hash: pending.phoneHash,
      state: "awaiting_location",
      photo_url: pending.photoUrl,
      photo_path: pending.photoPath,
      caption: pending.caption,
      category: pending.category,
      severity: pending.severity,
      category_confidence: pending.categoryConfidence,
      reason: pending.reason,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "phone_hash" }
  );
  if (error) throw error;
}

export async function clearPending(db: SupabaseClient, phoneHash: string): Promise<void> {
  const { error } = await db.from(TABLE).delete().eq("phone_hash", phoneHash);
  if (error) throw error;
}

/**
 * Minimum gap between accepted photos from one number.
 *
 * There is no rate limiting anywhere else in this codebase, and it matters more
 * here than elsewhere: this is the only endpoint where an unauthenticated
 * request triggers a vision call, a storage write and an outbound email. A
 * per-sender cooldown is not a substitute for real abuse handling, but it stops
 * a stuck client or a bored tester from spending the whole Gemini quota in a
 * few seconds.
 */
export const PHOTO_COOLDOWN_MS = 15_000;

export function withinCooldown(pending: PendingReport | null): boolean {
  if (!pending) return false;
  return Date.now() - pending.updatedAt < PHOTO_COOLDOWN_MS;
}
