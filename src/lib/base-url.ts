/**
 * The app's own absolute origin, for links that leave the browser.
 *
 * Anything rendered in a page can use a relative URL. A tracking link sent over
 * WhatsApp or quoted in an email cannot — it has to resolve from a phone with
 * no idea what host served it.
 *
 * Order matters: an explicit PUBLIC_BASE_URL wins, because VERCEL_URL is the
 * per-DEPLOYMENT hostname. Falling back to it keeps preview deployments working,
 * but in production it produces links pinned to one immutable deployment rather
 * than to the domain, which is why it is second and not first.
 */
export function baseUrl(): string {
  const explicit = process.env.PUBLIC_BASE_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

/** The unauthenticated tracking page for one report, addressed by public_token. */
export function trackUrl(token: string): string {
  return `${baseUrl()}/track/${token}`;
}
