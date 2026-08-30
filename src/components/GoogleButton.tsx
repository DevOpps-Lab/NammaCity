"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * Google OAuth entry point.
 *
 * Runs from the browser rather than a Server Action because supabase-js needs
 * to stash the PKCE verifier client-side before redirecting; the matching
 * exchange happens server-side in /auth/callback.
 */
export default function GoogleButton({
  next = "/",
  label = "Continue with Google",
}: {
  next?: string;
  label?: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setPending(true);
    setError(null);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });

    // On success the browser is already navigating away, so this only runs on
    // failure — most often the Google provider not being enabled yet.
    if (error) {
      setError(
        error.message.toLowerCase().includes("provider is not enabled")
          ? "Google sign-in isn't enabled on this project yet. Use email and password below."
          : error.message
      );
      setPending(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={signIn}
        disabled={pending}
        className="btn btn-outline w-full font-medium"
      >
        {pending ? (
          <span
            aria-hidden
            className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--text-faint)] border-t-[var(--text)]"
          />
        ) : (
          <GoogleMark />
        )}
        <span>{pending ? "Redirecting…" : label}</span>
      </button>

      {error && (
        <p
          role="alert"
          className="fade-in mt-2 rounded-[var(--radius-control)] border border-[var(--warning)]/35 bg-[var(--warning)]/10 px-3 py-2 text-[12px] text-[var(--warning)]"
        >
          {error}
        </p>
      )}
    </div>
  );
}

function GoogleMark() {
  return (
    <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#FFC107"
        d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.05 6.05 29.3 4 24 4 12.95 4 4 12.95 4 24s8.95 20 20 20 20-8.95 20-20c0-1.3-.14-2.7-.4-3.9Z"
      />
      <path
        fill="#FF3D00"
        d="m6.3 14.7 6.6 4.8C14.65 15.1 18.95 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.05 6.05 29.3 4 24 4 16.3 4 9.65 8.35 6.3 14.7Z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.85-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.65-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44Z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.6l6.2 5.2C36.9 40.2 44 35 44 24c0-1.3-.14-2.7-.4-3.9Z"
      />
    </svg>
  );
}
