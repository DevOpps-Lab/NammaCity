"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import GoogleButton from "./GoogleButton";
import { login, signup, type AuthState } from "@/app/auth/actions";

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="mt-1 flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-[var(--accent)] text-[14px] font-semibold text-[var(--on-accent)] transition active:scale-[0.99] disabled:opacity-60"
    >
      {pending && (
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
      )}
      {pending ? "Working…" : label}
    </button>
  );
}

function Field({
  label,
  name,
  type = "text",
  autoComplete,
  placeholder,
  defaultValue,
  hint,
}: {
  label: string;
  name: string;
  type?: string;
  autoComplete?: string;
  placeholder?: string;
  defaultValue?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-[var(--text-dim)]">
        {label}
      </span>
      <input
        name={name}
        type={type}
        required
        autoComplete={autoComplete}
        placeholder={placeholder}
        defaultValue={defaultValue}
        className="h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 text-[14px] text-[var(--text)] outline-none transition placeholder:text-[var(--text-faint)] focus:border-[var(--accent)]"
      />
      {hint && (
        <span className="mt-1 block text-[11px] text-[var(--text-faint)]">{hint}</span>
      )}
    </label>
  );
}

export default function AuthForm({
  mode,
  next = "/",
  initialError,
}: {
  mode: "login" | "signup";
  next?: string;
  /** Surfaced by /auth/callback when the OAuth round trip fails. */
  initialError?: string;
}) {
  const action = mode === "login" ? login : signup;
  const [state, formAction] = useActionState<AuthState | undefined, FormData>(
    action,
    undefined
  );

  const error = state?.error ?? initialError;

  return (
    <>
      <div className="rise-in" style={{ animationDelay: "40ms" }}>
        <GoogleButton
          next={next}
          label={mode === "login" ? "Sign in with Google" : "Sign up with Google"}
        />
      </div>

      <div
        className="rise-in my-6 flex items-center gap-3"
        style={{ animationDelay: "100ms" }}
      >
        <span className="h-px flex-1 bg-[var(--border-strong)]" />
        <span className="shrink-0 text-[10.5px] font-medium uppercase tracking-[0.12em] text-[var(--text-faint)]">
          or with email
        </span>
        <span className="h-px flex-1 bg-[var(--border-strong)]" />
      </div>

      <form
        action={formAction}
        className="rise-in flex flex-col gap-3.5"
        style={{ animationDelay: "140ms" }}
      >
      <input type="hidden" name="next" value={next} />

      {mode === "signup" && (
        <Field
          label="Your name"
          name="display_name"
          autoComplete="name"
          placeholder="Aravind Kumar"
        />
      )}

      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        placeholder="you@example.com"
      />

      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete={mode === "login" ? "current-password" : "new-password"}
        placeholder="••••••••"
        hint={mode === "signup" ? "At least 8 characters." : undefined}
      />

      {error && (
        <p
          role="alert"
          className="shake-in rounded-lg border border-[var(--danger)]/35 bg-[var(--danger)]/10 px-3 py-2 text-[12px] leading-relaxed text-[var(--danger)]"
        >
          {error}
        </p>
      )}

      {state?.notice && (
        <p
          role="status"
          className="rounded-lg border border-[var(--success)]/35 bg-[var(--success)]/10 px-3 py-2 text-[12px] text-[var(--success)]"
        >
          {state.notice}
        </p>
      )}

      <SubmitButton label={mode === "login" ? "Sign in" : "Create account"} />

      <p className="mt-1 text-center text-[12px] text-[var(--text-dim)]">
        {mode === "login" ? (
          <>
            No account yet?{" "}
            <Link href="/signup" className="font-medium text-[var(--accent)] hover:underline">
              Create one
            </Link>
          </>
        ) : (
          <>
            Already have an account?{" "}
            <Link href="/login" className="font-medium text-[var(--accent)] hover:underline">
              Sign in
            </Link>
          </>
        )}
      </p>
      </form>
    </>
  );
}
