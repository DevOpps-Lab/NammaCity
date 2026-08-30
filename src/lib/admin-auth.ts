import { createClient } from "./supabase/server";

/**
 * Is the caller a government account?
 *
 * A sibling to `authorisedScheduler` in api-auth.ts, and deliberately NOT a
 * reuse of it: that helper returns true for any signed-in user and for anyone
 * holding INBOUND_POLL_SECRET, which is exactly the wrong answer here.
 *
 * This is the cheap check, for deciding whether to render a page. It is not the
 * security boundary. The boundary is `civic_is_gov()` inside every
 * `civic_admin_*` function in Postgres, which raises rather than returning a
 * smaller result set. That split matters because src/proxy.ts only asks whether
 * a user exists, and `reports_select_community` already lets any signed-in
 * browser read the whole non-seed ledger — so a check that lived only in the UI
 * would hide the console and guard nothing behind it.
 *
 * Reads `profiles` through the ordinary session client, not the service role:
 * RLS already permits a user to read their own profile row, so no bypass is
 * needed to ask a question about yourself.
 */
export async function isGovUser(): Promise<boolean> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;

  const { data, error } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  // A missing column (migration not applied yet) or a missing row must fail
  // closed. Degrading to "allowed" on error is how a console ends up open.
  if (error || !data) return false;

  return (data as { role?: string }).role === "gov";
}
