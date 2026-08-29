import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseEnv } from "@/lib/supabase/env";
import { fetchWithRetry } from "@/lib/supabase/fetch";

/**
 * Next 16 renamed Middleware to Proxy. Same execution model.
 *
 * Two jobs:
 *  1. Refresh the Supabase auth token and write the rotated cookies onto the
 *     response, so a Server Component never reads a stale session.
 *  2. An OPTIMISTIC redirect for unauthenticated visitors. Optimistic is the
 *     operative word — the real authorisation boundary is Postgres RLS, not
 *     this file. Every table is owner-scoped, so a forged cookie that got past
 *     here would still read zero rows.
 */

// /api/inbound/poll is reachable without a session because a cron/backstop
// caller has none — it authorises itself with INBOUND_POLL_SECRET (and still
// accepts a logged-in session for the in-app poll). The route returns 401 on
// its own if neither is present, so opening the proxy here leaks nothing. Other
// /api routes stay behind the optimistic guard so they can't be hit anonymously.
//
// /api/whatsapp is open for the same reason and with the same discipline:
// Twilio sends no cookies, so a guarded route would hand it a 307 to /login and
// the citizen would get an HTML page instead of a reply. The route verifies
// Twilio's X-Twilio-Signature itself and fails closed, so opening the proxy
// does not make it unauthenticated — it moves the check into the handler.
//
// /track/ is open because a citizen who filed over WhatsApp has no account at
// all. It renders one report, addressed by an unguessable public_token rather
// than by its (enumerable) id, read through the service-role client since every
// RLS policy is owner-scoped and the anon key would read nothing. The trailing
// slash matters: these are startsWith prefixes, so a bare "/track" would also
// match a future "/tracking-something".
//
// /api/track/ is the action half of that page — the after-photo that closes a
// report. Open for the same reason (there is no session to gate on) and with
// the same discipline: the route authorises on the public_token alone, and
// because a token is a bearer credential and not an identity, it will only
// close a report when the vision check independently agrees the defect is gone.
// A token by itself closes nothing.
const PUBLIC_PATHS = [
  "/login",
  "/signup",
  "/auth",
  "/api/inbound/poll",
  "/api/whatsapp",
  "/api/track/",
  "/track/",
];

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const { url: supabaseUrl, key: supabaseKey } = supabaseEnv();

  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    // Every navigation calls getUser() through this client; without the retry a
    // reset socket bounces a signed-in user to /login at random.
    global: { fetch: fetchWithRetry },
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // getUser() revalidates against the auth server. Do NOT swap this for
  // getSession(), which trusts the cookie payload without verifying it.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    // Preserve where they were headed so login can bounce them back.
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (user && (pathname === "/login" || pathname === "/signup")) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and image files. The service worker and
     * manifest are excluded so the PWA shell still installs while logged out.
     */
    "/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest|data/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
