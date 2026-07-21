import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { fetchWithRetry } from "./fetch";

/**
 * SERVICE-ROLE Supabase client. SERVER-ONLY.
 *
 * The inbound-email webhook (`/api/inbound/poll`) has to read and update a
 * report on behalf of a citizen it has no session for — an authority replied by
 * email, and there is no browser, no cookie, no `auth.uid()`. So it uses the
 * service_role key, which bypasses RLS.
 *
 * That makes this the one place in the app where the owner-scoping guarantee is
 * NOT enforced by the database, so it must be enforced by us instead: every
 * query here is written with an explicit `.eq("user_id", ...)` derived from the
 * matched outbox row, never a trusted-from-the-wire value.
 *
 * This module must never be imported by client code. It is guarded by a
 * `server-only`-style runtime check and reads a key with no NEXT_PUBLIC_ prefix,
 * so it cannot be bundled into the browser.
 */

const MESSAGE =
  "Server email handling is not configured. Set SUPABASE_SERVICE_ROLE_KEY " +
  "(Supabase Dashboard -> Project Settings -> API -> service_role) in " +
  ".env.local, then restart. See README > Setup.";

let cached: SupabaseClient | null = null;

/** Returns null when the service role key is absent, so callers can degrade. */
export function adminConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

export function createAdminClient(): SupabaseClient {
  if (typeof window !== "undefined") {
    throw new Error("createAdminClient() must never run in the browser.");
  }
  if (!adminConfigured()) throw new Error(MESSAGE);
  if (cached) return cached;

  cached = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: fetchWithRetry },
    }
  );
  return cached;
}
