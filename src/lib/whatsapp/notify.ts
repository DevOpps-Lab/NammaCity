import type { SupabaseClient } from "@supabase/supabase-js";
import { categoryLabel } from "../categories";
import { trackUrl } from "../base-url";
import { now } from "../demoClock";
import { fetchReportByOwner } from "../db";
import { postReportUpdate } from "../public-post";
import type { IssueCategory } from "../types";
import { OUTSIDE_WINDOW_CODE, sendWhatsApp, twilioConfigured } from "./twilio";

/**
 * OUTBOUND WHATSAPP — closing the loop the intake reply promised.
 *
 * Filing tells the citizen "we'll ask for an after-photo when the agency claims
 * it's fixed". Nothing could ask: every other message in this integration is
 * TwiML inside a webhook response, which only exists because the citizen just
 * messaged us. A notification is unsolicited by definition, so it needs the
 * REST API (twilio.ts#sendWhatsApp) and a record of who to send it to
 * (0011_whatsapp_notify.sql).
 *
 * WHAT THIS CAN AND CANNOT DELIVER. WhatsApp permits a freeform business
 * message only within 24 hours of the citizen's last inbound message; outside
 * that Twilio returns 63016 and the send needs a Meta-approved template. So
 * `claims_done` — which usually lands while the conversation is still warm, and
 * is the one notification the product actually depends on — normally gets
 * through, while a `past_sla` three days later normally does not. That is a
 * platform rule, not a bug, and it is recorded per-notification rather than
 * swallowed. The tracking link has no such limit and remains the channel that
 * always works.
 *
 * IDEMPOTENCE. The escalation trigger is `civic_sweep_owner`, which returns
 * every past_sla/escalated report on every call rather than only the ones that
 * just moved. So instead of reconstructing "what is new", the unique key on
 * whatsapp_notifications does the deduplication: an insert that conflicts is a
 * notification already handled.
 */

export type NotifyKind = "claims_done" | "past_sla" | "escalated" | "verified_fixed";

/** Rows older than this are abandoned rather than retried forever. */
const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How many messages one sweep may actually put on the wire.
 *
 * This is a latency budget, not a policy. `sweepAndNotify` runs INLINE on the
 * webhook path — a citizen is waiting on a TwiML reply and Twilio abandons the
 * request after 15 seconds — so a ledger with thirty overdue reports must not
 * turn one person's "here is my location" into thirty sequential HTTP calls to
 * Twilio before they hear anything back.
 *
 * Capping is safe precisely because the ledger is idempotent: a notification
 * skipped now is simply recorded by the next sweep or the next poll, and the
 * unique key still guarantees it is sent at most once. The webhook takes the
 * small budget; the cron-shaped poll, where nobody is waiting, takes the
 * default.
 */
const DEFAULT_SEND_BUDGET = 15;
export const WEBHOOK_SEND_BUDGET = 4;

interface NotifiableReport {
  id: string;
  status: string;
  category: IssueCategory;
  place: string;
  slaDeadline: number;
  token: string | null;
}

// ------------------------------------------------------------------- target

/**
 * Remembers where to reach the filer of one report.
 *
 * Called once, at filing. Deliberately non-fatal: a citizen's report must not
 * fail to file because we could not record a notification address.
 */
export async function recordNotifyTarget(
  admin: SupabaseClient,
  owner: string,
  reportId: string,
  phone: string
): Promise<void> {
  const { error } = await admin
    .from("whatsapp_notify")
    .upsert(
      { report_owner: owner, report_id: reportId, phone },
      { onConflict: "report_owner,report_id" }
    );
  if (error) console.warn("[whatsapp] could not record a notify target", error.message);
}

async function targetPhone(
  admin: SupabaseClient,
  owner: string,
  reportId: string
): Promise<string | null> {
  const { data, error } = await admin
    .from("whatsapp_notify")
    .select("phone")
    .eq("report_owner", owner)
    .eq("report_id", reportId)
    .maybeSingle();
  if (error) {
    console.warn("[whatsapp] notify target lookup failed", error.message);
    return null;
  }
  return (data?.phone as string | undefined) ?? null;
}

/**
 * Drops the stored number once the report is closed and its closing message has
 * been dealt with. The raw phone number is the one piece of citizen PII this
 * feature persists — 0009 went out of its way to avoid it — so its lifetime is
 * bounded by the thing that needed it rather than left to the FK cascade.
 */
async function forgetTarget(
  admin: SupabaseClient,
  owner: string,
  reportId: string
): Promise<void> {
  await admin
    .from("whatsapp_notify")
    .delete()
    .eq("report_owner", owner)
    .eq("report_id", reportId);
}

// ----------------------------------------------------------------- messages

function compose(kind: NotifyKind, report: NotifiableReport): string {
  const what = categoryLabel(report.category);
  const where = report.place ? ` (${report.place})` : "";
  const link = report.token ? `\n\n${trackUrl(report.token)}` : "";
  const deadline = new Date(report.slaDeadline).toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  });

  switch (kind) {
    // The message this whole feature exists for. `claims_done` is the only
    // state the loop cannot leave without a human, so the ask has to be
    // concrete and the non-closure has to be explicit — an authority saying
    // "done" is precisely what this product refuses to take at face value.
    case "claims_done":
      return `🔧 The authority says your *${what}* report ${report.id}${where} has been fixed.

*It is not closed.* We don't close a report on an authority's word.

If it really is fixed, open the link below and send an after-photo — we check it and close the case.
If it isn't fixed, do nothing. The clock keeps running and we keep escalating.${link}`;

    case "past_sla":
      return `⏰ ${report.id}${where} — *${what}* — has passed the deadline the authority publishes for itself (${deadline}).

Still open. We're keeping the record.${link}`;

    case "escalated":
      return `📣 ${report.id}${where} — *${what}* — is still unresolved past the published standard, so it has been escalated to the public ledger.${link}`;

    case "verified_fixed":
      return `✅ ${report.id}${where} — *${what}* — is closed. An after-photo was checked and the defect is gone.

Thank you — a verified fix is worth more than a claimed one.${link}`;
  }
}

// --------------------------------------------------------------------- send

async function loadReport(
  admin: SupabaseClient,
  owner: string,
  reportId: string
): Promise<NotifiableReport | null> {
  const { data, error } = await admin
    .from("reports")
    .select("id, status, category, place, sla_deadline, public_token")
    .eq("user_id", owner)
    .eq("id", reportId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: data.id as string,
    status: data.status as string,
    category: data.category as IssueCategory,
    place: (data.place as string) ?? "",
    slaDeadline: Number(data.sla_deadline ?? 0),
    token: (data.public_token as string | null) ?? null,
  };
}

/** `code: message`, so a permanent failure is recognisable on the way back in. */
function errorText(code: number | null, message: string): string {
  return `${code ?? "err"}: ${message}`;
}

function permanentlyFailed(deliveryError: string | null): boolean {
  return Boolean(deliveryError?.startsWith(`${OUTSIDE_WINDOW_CODE}:`));
}

async function attempt(
  admin: SupabaseClient,
  row: { id: string; phone: string; body: string }
): Promise<boolean> {
  const outcome = await sendWhatsApp(row.phone, row.body);
  if (outcome.ok) {
    await admin
      .from("whatsapp_notifications")
      .update({ delivered: true, provider_message_id: outcome.sid, delivery_error: null })
      .eq("id", row.id);
    return true;
  }
  await admin
    .from("whatsapp_notifications")
    .update({ delivery_error: errorText(outcome.code, outcome.message) })
    .eq("id", row.id);
  if (outcome.code === OUTSIDE_WINDOW_CODE) {
    console.info(
      `[whatsapp] ${row.id} not delivered — outside the 24h window; the tracking link still works`
    );
  } else {
    console.warn(`[whatsapp] notification send failed: ${outcome.message}`);
  }
  return false;
}

export type NotifyResult = "sent" | "queued" | "duplicate" | "no-target" | "skipped";

/**
 * Records and attempts one notification. Safe to call repeatedly for the same
 * (report, kind) — the second call is a no-op.
 */
export async function notifyStatus(
  admin: SupabaseClient,
  input: { owner: string; reportId: string; kind: NotifyKind }
): Promise<NotifyResult> {
  if (!twilioConfigured()) return "skipped";

  const phone = await targetPhone(admin, input.owner, input.reportId);
  // No target is the ordinary case: a report filed in the app has no phone here.
  if (!phone) return "no-target";

  const report = await loadReport(admin, input.owner, input.reportId);
  if (!report) return "skipped";

  const body = compose(input.kind, report);

  const { data: claimed, error } = await admin
    .from("whatsapp_notifications")
    .insert({
      report_owner: input.owner,
      report_id: input.reportId,
      kind: input.kind,
      phone,
      body,
      at: now(),
    })
    .select("id")
    .maybeSingle();

  // 23505 = unique violation: this notification was already recorded, so it has
  // already been sent or already failed. Either way, not again.
  if (error) {
    if (error.code === "23505") return "duplicate";
    console.warn("[whatsapp] could not record a notification", error.message);
    return "skipped";
  }
  if (!claimed?.id) return "skipped";

  const sent = await attempt(admin, { id: claimed.id as string, phone, body });
  if (input.kind === "verified_fixed") {
    await forgetTarget(admin, input.owner, input.reportId);
  }
  return sent ? "sent" : "queued";
}

/**
 * Retries notifications that were recorded but not delivered.
 *
 * A transient failure (Twilio unreachable, a network blip) should not cost a
 * citizen the one message that asks them to act. A 63016 is not transient, so
 * those are left alone rather than retried into a rate limit, and anything
 * older than a day is abandoned — a stale SLA notice is not worth delivering.
 */
export async function flushPending(
  admin: SupabaseClient,
  budget = DEFAULT_SEND_BUDGET
): Promise<number> {
  if (!twilioConfigured() || budget <= 0) return 0;

  const { data, error } = await admin
    .from("whatsapp_notifications")
    .select("id, phone, body, delivery_error, at")
    .eq("delivered", false)
    .gte("at", now() - RETRY_WINDOW_MS)
    .order("at", { ascending: true })
    .limit(budget);
  if (error || !data?.length) return 0;

  let sent = 0;
  let spent = 0;
  for (const row of data) {
    if (spent >= budget) break;
    if (permanentlyFailed(row.delivery_error as string | null)) continue;
    spent += 1;
    const delivered = await attempt(admin, {
      id: row.id as string,
      phone: row.phone as string,
      body: row.body as string,
    });
    if (delivered) sent += 1;
  }
  return sent;
}

/**
 * Advances the intake ledger and tells the citizens what moved.
 *
 * `civic_sweep` is `security invoker` and reads `auth.uid()`, so it is a no-op
 * under the service-role client — which is why 0010 added the owner-scoped
 * variant. Nobody ever logs in as the intake account, so without this call
 * these reports would sit at 'filed' forever, deadline receding.
 *
 * Never throws: a sweep or notification problem must not cost a citizen their
 * filed report, and this runs inline on the webhook path.
 */
export async function sweepAndNotify(
  admin: SupabaseClient,
  owner: string,
  budget = DEFAULT_SEND_BUDGET
): Promise<{ swept: number; notified: number; posted: number }> {
  let swept = 0;
  let notified = 0;
  let posted = 0;
  let spent = 0;

  try {
    const { data, error } = await admin.rpc("civic_sweep_owner", {
      p_owner: owner,
      p_now: now(),
    });
    if (error) {
      console.warn("[whatsapp] sweep failed", error.message);
    } else {
      const rows = (data ?? []) as { id: string; status: string }[];
      swept = rows.length;
      for (const row of rows) {
        if (spent >= budget) break;
        if (row.status !== "past_sla" && row.status !== "escalated") continue;

        // ANNOUNCE IT PUBLICLY. The app posts to the Namma Chennai timeline
        // from the browser when a report newly escalates; nobody ever has this
        // account open, so a WhatsApp report used to escalate into silence —
        // recorded in the ledger, published nowhere. `once` because the sweep
        // re-reports the same escalated rows on every call.
        if (row.status === "escalated") {
          const full = await fetchReportByOwner(admin, owner, row.id);
          if (full) {
            posted += (await postReportUpdate(admin, full, owner, "escalation", { once: true }))
              ? 1
              : 0;
          }
        }

        const result = await notifyStatus(admin, {
          owner,
          reportId: row.id,
          kind: row.status,
        });
        // Only a real send attempt costs budget. A report with no stored number
        // (every report filed in the app) or one already notified is a single
        // indexed lookup, and rate-limiting those would strand the ledger.
        if (result === "sent" || result === "queued") spent += 1;
        if (result === "sent") notified += 1;
      }
    }
  } catch (err) {
    console.warn("[whatsapp] sweep threw", err);
  }

  try {
    notified += await flushPending(admin, budget - spent);
  } catch (err) {
    console.warn("[whatsapp] flush threw", err);
  }

  return { swept, notified, posted };
}
