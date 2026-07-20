const MESSAGE =
  "Supabase is not configured. Copy .env.example to .env.local and fill in " +
  "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY from your " +
  "project's Settings -> API, then restart the dev server. See README > Setup.";

/**
 * Env resolution with an actionable failure.
 *
 * Without this, a missing key surfaces as `Invalid URL` from deep inside the
 * Supabase client — which sends you looking in the wrong place entirely.
 *
 * `strict` exists because of prerendering. The home page is a client component,
 * so Next still renders it once on the server at build time, which constructs a
 * browser client for a pass that never issues a request. Throwing there would
 * fail `next build` on a machine that legitimately has no secrets. So the
 * browser client resolves leniently during that pass and throws for real once
 * it's actually in a browser; server code, which always needs working
 * credentials, throws immediately.
 */
export function supabaseEnv({ strict = true }: { strict?: boolean } = {}) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const configured = Boolean(url && key && !url.includes("placeholder"));

  if (configured) return { url: url!, key: key! };

  if (strict || typeof window !== "undefined") throw new Error(MESSAGE);

  // Prerender-only fallback. Never reached in a browser or on a real request.
  return { url: "https://unconfigured.supabase.co", key: "unconfigured" };
}
