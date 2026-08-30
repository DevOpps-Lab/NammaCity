"use client";

import { useActionState, useId } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import GoogleButton from "./GoogleButton";
import { login, signup, type AuthState } from "@/app/auth/actions";

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn btn-primary btn-lg mt-1 w-full">
      {pending && (
        <span
          aria-hidden
          className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--on-accent)]/40 border-t-[var(--on-accent)]"
        />
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
  hint,
}: {
  label: string;
  name: string;
  type?: string;
  autoComplete?: string;
  placeholder?: string;
  hint?: string;
}) {
  const id = useId();
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1.5 block text-[12px] font-medium text-[var(--text-dim)]"
      >
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        required
        autoComplete={autoComplete}
        placeholder={placeholder}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="field"
      />
      {hint && (
        <span id={`${id}-hint`} className="mt-1 block text-[11px] text-[var(--text-faint)]">
          {hint}
        </span>
      )}
    </div>
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
  const errorId = useId();
  const error = state?.error ?? initialError;

  return (
    <>
      <div className="enter" style={{ animationDelay: "40ms" }}>
        <GoogleButton
          next={next}
          label={mode === "login" ? "Sign in with Google" : "Sign up with Google"}
        />
      </div>

      <div
        className="enter my-6 flex items-center gap-3"
        style={{ animationDelay: "100ms" }}
      >
        <span aria-hidden className="h-px flex-1 bg-[var(--border-strong)]" />
        <span className="t-micro">or with email</span>
        <span aria-hidden className="h-px flex-1 bg-[var(--border-strong)]" />
      </div>

      <form
        action={formAction}
        aria-describedby={error ? errorId : undefined}
        className="enter flex flex-col gap-3.5"
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
          placeholder="At least 8 characters"
          hint={mode === "signup" ? "At least 8 characters." : undefined}
        />

        {error && (
          <p
            id={errorId}
            role="alert"
            className="shake-in rounded-[var(--radius-control)] border border-[var(--danger)]/35 bg-[var(--danger)]/10 px-3 py-2 text-[12px] leading-relaxed text-[var(--danger)]"
          >
            {error}
          </p>
        )}

        {state?.notice && (
          <p
            role="status"
            className="rounded-[var(--radius-control)] border border-[var(--success)]/35 bg-[var(--success)]/10 px-3 py-2 text-[12px] text-[var(--success)]"
          >
            {state.notice}
          </p>
        )}

        <SubmitButton label={mode === "login" ? "Sign in" : "Create account"} />

        <p className="mt-1 text-center text-[12px] text-[var(--text-dim)]">
          {mode === "login" ? (
            <>
              No account yet?{" "}
              <Link
                href="/signup"
                className="font-medium text-[var(--accent)] underline-offset-2 hover:underline"
              >
                Create one
              </Link>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <Link
                href="/login"
                className="font-medium text-[var(--accent)] underline-offset-2 hover:underline"
              >
                Sign in
              </Link>
            </>
          )}
        </p>
      </form>
    </>
  );
}
