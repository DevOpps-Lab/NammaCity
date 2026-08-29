import { createClient } from "./supabase/server";

/**
 * Authorises a route that a scheduler must be able to call.
 *
 * Two accepted callers, and the pair is the point:
 *
 *  - **A scheduler**, which has no session and never will — n8n, a cron, a
 *    monitoring probe. It proves itself with `INBOUND_POLL_SECRET`.
 *  - **A signed-in user**, so the same endpoint stays usable from the app
 *    without inventing a second code path.
 *
 * Lifted out of `src/app/api/inbound/poll/route.ts`, where it was written for
 * exactly this and then needed again the moment a second scheduled endpoint
 * appeared. One implementation means the escalation routes cannot drift into a
 * weaker check than the poll route's.
 *
 * Note the ordering: the secret is compared BEFORE `getUser()` is called, so a
 * scheduled request never pays for a Supabase round-trip it does not need.
 */
export async function authorisedScheduler(req: Request): Promise<boolean> {
  const secret = process.env.INBOUND_POLL_SECRET;
  if (secret && req.headers.get("x-poll-secret") === secret) return true;

  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return Boolean(data.user);
}
