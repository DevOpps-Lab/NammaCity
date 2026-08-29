"use client";

import { useEffect, useRef, useState } from "react";
import { signOut } from "@/app/auth/actions";

function initials(name: string, email: string) {
  const src = name.trim() || email.split("@")[0] || "?";
  const parts = src.split(/[\s._-]+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : src.slice(0, 2)).toUpperCase();
}

export default function UserMenu({
  displayName,
  email,
  avatarUrl,
  onReset,
  onSeed,
}: {
  displayName: string;
  email: string;
  /** Present for Google sign-ins; falls back to initials otherwise. */
  avatarUrl?: string | null;
  onReset: () => void;
  onSeed: () => void;
}) {
  const [avatarBroken, setAvatarBroken] = useState(false);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click and on Escape — a menu that traps the user over a
  // full-screen map is worse than no menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setConfirming(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setConfirming(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className="grid h-9 w-9 place-items-center overflow-hidden rounded-lg bg-[var(--accent)]/18 text-[11px] font-bold text-[var(--accent)] transition-all duration-200 hover:bg-[var(--accent)]/28 active:scale-95"
      >
        {avatarUrl && !avatarBroken ? (
          /* Plain img, not next/image: avoids configuring remotePatterns for
             every OAuth provider's avatar CDN, and it's a 36px thumbnail. */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt=""
            width={36}
            height={36}
            referrerPolicy="no-referrer"
            onError={() => setAvatarBroken(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          initials(displayName, email)
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="fade-in absolute right-0 top-11 z-[var(--z-modal)] w-60 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-[0_10px_40px_rgba(0,0,0,0.6)]"
        >
          <div className="border-b border-[var(--border)] px-3.5 py-3">
            <p className="truncate text-[13px] font-semibold text-[var(--text)]">
              {displayName || "Citizen"}
            </p>
            <p className="mt-0.5 truncate text-[11px] text-[var(--text-faint)]">{email}</p>
          </div>

          <div className="p-1.5">
            {confirming ? (
              <div className="px-2 py-1.5">
                <p className="text-[11px] leading-relaxed text-[var(--text-dim)]">
                  Delete every report in your ledger and restore the seeded
                  caseload? This can&apos;t be undone.
                </p>
                <div className="mt-2 flex gap-1.5">
                  <button
                    onClick={() => {
                      onReset();
                      setOpen(false);
                      setConfirming(false);
                    }}
                    className="flex-1 rounded-md bg-[var(--danger)] px-2 py-1.5 text-[11px] font-semibold text-[var(--on-accent)]"
                  >
                    Reset
                  </button>
                <button
                  onClick={() => setConfirming(false)}
                  className="flex-1 rounded-md border border-[var(--border)] px-2 py-1.5 text-[11px] font-medium text-[var(--text-dim)]"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                role="menuitem"
                onClick={() => {
                  onSeed();
                  setOpen(false);
                }}
                className="w-full rounded-md px-2.5 py-2 text-left text-[12px] text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
              >
                Seed sample data
              </button>
              <button
                role="menuitem"
                onClick={() => setConfirming(true)}
                className="w-full rounded-md px-2.5 py-2 text-left text-[12px] text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
              >
                Reset my ledger
              </button>
            </>
          )}

            <form action={signOut}>
              <button
                role="menuitem"
                type="submit"
                className="w-full rounded-md px-2.5 py-2 text-left text-[12px] text-[var(--text-dim)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
