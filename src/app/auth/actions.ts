"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export interface AuthState {
  error?: string;
  notice?: string;
}

/** Kept deliberately small — no dependency added just to check two fields. */
function validate(email: string, password: string): string | null {
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return "Enter a valid email address.";
  }
  if (password.length < 8) {
    return "Password must be at least 8 characters.";
  }
  return null;
}

/**
 * Turn provider errors into something a person can act on.
 *
 * A transport failure surfaces from supabase-js as the bare string
 * "fetch failed", which reads as a bug in the app when it usually means the
 * project URL is wrong or the network is down.
 */
function humanize(message: string): string {
  const m = message.toLowerCase();

  if (m.includes("fetch failed") || m.includes("failed to fetch") || m.includes("network")) {
    return "Couldn't reach the authentication service. Check your connection, and that NEXT_PUBLIC_SUPABASE_URL in .env.local points at your project.";
  }
  // Deliberately vague upstream so the form can't be used to enumerate which
  // emails have accounts — keep it that way.
  if (m.includes("invalid login credentials")) {
    return "That email and password don't match an account.";
  }
  if (m.includes("email not confirmed")) {
    return "This account still needs confirming. Check your inbox for the link.";
  }
  if (m.includes("already registered") || m.includes("already been registered")) {
    return "An account with that email already exists. Try signing in instead.";
  }
  return message;
}
export async function login(
  _prev: AuthState | undefined,
  formData: FormData
): Promise<AuthState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/");

  const invalid = validate(email, password);
  if (invalid) return { error: invalid };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) return { error: humanize(error.message) };

  revalidatePath("/", "layout");
  redirect(next.startsWith("/") ? next : "/");
}

export async function signup(
  _prev: AuthState | undefined,
  formData: FormData
): Promise<AuthState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const displayName = String(formData.get("display_name") ?? "").trim();

  const invalid = validate(email, password);
  if (invalid) return { error: invalid };
  if (displayName.length < 2) return { error: "Enter your name." };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { display_name: displayName } },
  });

  if (error) return { error: humanize(error.message) };

  // With "Confirm email" disabled (the demo configuration) Supabase returns a
  // live session and we go straight in. With it enabled there is no session
  // yet, so we ask them to check their inbox instead of silently doing nothing.
  if (!data.session) {
    return {
      notice: `Account created. Check ${email} for a confirmation link, then sign in.`,
    };
  }

  revalidatePath("/", "layout");
  redirect("/");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}
