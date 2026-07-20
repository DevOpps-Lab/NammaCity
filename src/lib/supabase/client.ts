import { createBrowserClient } from "@supabase/ssr";
import { supabaseEnv } from "./env";
import { fetchWithRetry } from "./fetch";

/**
 * Browser-side Supabase client.
 *
 * Safe to call repeatedly — `createBrowserClient` memoises internally, so this
 * returns the same instance and we don't end up with competing auth listeners.
 */
export function createClient() {
  const { url, key } = supabaseEnv({ strict: false });
  // Browser fetch doesn't have undici's pooling bug, but the same retry makes
  // the app tolerate the patchy mobile data its users are actually on.
  return createBrowserClient(url, key, { global: { fetch: fetchWithRetry } });
}
