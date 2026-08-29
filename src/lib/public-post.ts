import type { SupabaseClient } from "@supabase/supabase-js";
import { composePost, composeUpdate, guardText } from "./escalation";
import { postSocial } from "./social";
import { now } from "./demoClock";
import type { Report } from "./types";

/**
 * SERVER-SIDE PUBLIC POSTING — the twin of `store.publishPost()`.
 *
 * The Namma Chennai timeline is driven from the browser: `store.ts` watches the
 * citizen's own reports and posts when one newly escalates. That works for
 * every report filed in the app and for none filed over WhatsApp, because those
 * belong to a shared intake account nobody ever logs into — so their escalation
 * was recorded in the ledger and then announced to nobody, which is the one
 * thing escalation is for.
 *
 * Same composition, same guard, same `public_posts` row. The only difference is
 * that there is no session, so the author is passed in.
 */

/** Has this report already been posted about under this kind? */
async function alreadyPosted(
  admin: SupabaseClient,
  reportId: string,
  kind: "escalation" | "update"
): Promise<boolean> {
  const { data } = await admin
    .from("public_posts")
    .select("id")
    .eq("report_id", reportId)
    .eq("kind", kind)
    .limit(1)
    .maybeSingle();
  return Boolean(data?.id);
}

async function imageFor(report: Report): Promise<{ content: Buffer; mimeType: string } | null> {
  if (!report.photoUrl || report.photoUrl.startsWith("data:")) return null;
  try {
    const res = await fetch(report.photoUrl);
    if (!res.ok) return null;
    return {
      content: Buffer.from(await res.arrayBuffer()),
      mimeType: res.headers.get("content-type") ?? "image/jpeg",
    };
  } catch {
    // Post text-only rather than not at all.
    return null;
  }
}

/**
 * Posts about a report and records it.
 *
 * `once` is for the escalation path, where the trigger is `civic_sweep_owner`
 * returning every escalated report on every call rather than only the ones that
 * just moved — without it, a demo would re-post the same escalation on every
 * sweep. Best-effort throughout: a report's status is already durable in
 * Postgres and must not be undone by a failure to talk about it.
 */
export async function postReportUpdate(
  admin: SupabaseClient,
  report: Report,
  author: string,
  kind: "escalation" | "update" = "update",
  opts: { once?: boolean } = {}
): Promise<boolean> {
  try {
    if (opts.once && (await alreadyPosted(admin, report.id, kind))) return false;

    const composed = kind === "escalation" ? composePost(report) : composeUpdate(report);
    const guard = guardText(composed.text);
    const text = (guard.cleaned || composed.text).slice(0, 280);

    let source: "x" | "bluesky" | "simulated" = "simulated";
    let tweetId: string | null = null;
    let tweetUrl: string | null = null;

    const posted = await postSocial({ text, image: await imageFor(report) });
    if (posted) {
      source = posted.platform;
      tweetId = posted.id;
      tweetUrl = posted.url;
    }

    await admin.from("public_posts").insert({
      report_id: report.id,
      kind,
      body: text,
      source,
      tweet_id: tweetId,
      tweet_url: tweetUrl,
      author,
      at: now(),
    });
    return true;
  } catch (err) {
    console.warn("[public-post] failed", err);
    return false;
  }
}
