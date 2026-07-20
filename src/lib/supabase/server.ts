import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabaseEnv } from "./env";
import { fetchWithRetry } from "./fetch";

/**
 * Server-side Supabase client for Server Components, Route Handlers and
 * Server Actions.
 *
 * `cookies()` is async in Next 16, so this is too.
 */
export async function createClient() {
  const cookieStore = await cookies();
  const { url, key } = supabaseEnv();

  return createServerClient(url, key, {
    // Node's fetch resets pooled connections against this host; see ./fetch.ts.
    global: { fetch: fetchWithRetry },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component, where cookies are read-only.
          // The proxy refreshes the session, so this is safe to swallow.
        }
      },
    },
  });
}
