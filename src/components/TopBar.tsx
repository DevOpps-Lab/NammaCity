"use client";

import Icon from "./Icon";
import UserMenu from "./UserMenu";
import { t, type Lang } from "@/lib/i18n";

interface Props {
  stats: {
    open: number;
    breached: number;
    verified: number;
    fixRate: number;
    claimedRate: number;
  };
  lang: Lang;
  demo: boolean;
  outboxCount: number;
  displayName: string;
  email: string;
  avatarUrl?: string | null;
  onToggleLang: () => void;
  onToggleDemo: () => void;
  onOpenOutbox: () => void;
  onToggleTrace: () => void;
  onReset: () => void;
  /** Number of agent-trace lines — drives the live dot on the trace button. */
  traceCount: number;
}

export default function TopBar({
  stats,
  lang,
  demo,
  outboxCount,
  displayName,
  email,
  avatarUrl,
  onToggleLang,
  onToggleDemo,
  onOpenOutbox,
  onToggleTrace,
  onReset,
  traceCount,
}: Props) {
  return (
    // pt-safe keeps the bar clear of the Dynamic Island while the surface
    // colour still fills the notch area, so there's no seam above the header.
    <header className="pt-safe px-safe relative z-[var(--z-overlay)] shrink-0 border-b border-[var(--border)] bg-[var(--surface)]/95 shadow-[var(--shadow-1)] backdrop-blur">
      <div className="flex h-14 items-center gap-2 px-3 sm:px-4">
        {/* Brand */}
        <div className="flex shrink-0 items-center gap-2">
          <span
            className="grid h-8 w-8 place-items-center rounded-xl text-white shadow-[var(--shadow-1)]"
            style={{ background: "var(--brand-grad)" }}
          >
            <Icon name="shield" size={17} />
          </span>
          <div className="hidden sm:block">
            <p className="text-[13px] font-semibold leading-none tracking-tight">
              CivicAgent
            </p>
            <p className="mt-0.5 text-[10px] leading-none text-[var(--text-faint)]">
              Chennai
            </p>
          </div>
        </div>

        {/* Stats — the honest numbers, always visible */}
        <div className="ml-1 flex min-w-0 items-center gap-1 overflow-x-auto no-bar sm:gap-1.5">
          <Stat label={t(lang, "open")} value={stats.open} tone="var(--accent)" />
          <Stat label={t(lang, "pastSla")} value={stats.breached} tone="var(--danger)" />
          <Stat label={t(lang, "verified")} value={stats.verified} tone="var(--success)" />
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {/* Verified vs claimed — the whole thesis, as one number */}
          <div
            className="mr-1 hidden text-right md:block"
            title="Citizen-verified closures only. Authority claims are excluded — that gap is the point."
          >
            <p className="text-[15px] font-bold leading-none tabular-nums text-[var(--success)]">
              {stats.fixRate}%
            </p>
            <p className="mt-0.5 text-[9px] leading-none text-[var(--text-faint)]">
              verified · {stats.claimedRate}% claimed
            </p>
          </div>

          <IconBtn label="Switch language" onClick={onToggleLang}>
            <span className="text-[11px] font-semibold">
              {lang === "en" ? "தமிழ்" : "EN"}
            </span>
          </IconBtn>

          <IconBtn label="Open outbox" onClick={onOpenOutbox} badge={outboxCount}>
            <Icon name="inbox" size={17} />
          </IconBtn>

          <button
            onClick={onToggleDemo}
            aria-pressed={demo}
            title="Compress time so deadlines arrive during a demo"
            className={`press flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-semibold transition-colors ${
              demo
                ? "bg-[var(--warning)] text-[var(--on-accent)] shadow-[var(--shadow-1)]"
                : "border border-[var(--border)] text-[var(--text-dim)] hover:border-[var(--border-strong)] hover:text-[var(--text)]"
            }`}
          >
            <Icon name="clock" size={15} />
            <span className="hidden sm:inline">{demo ? "1s = 1h" : "Demo"}</span>
          </button>

          <IconBtn label="Agent trace" onClick={onToggleTrace}>
            <Icon name="activity" size={17} />
            {traceCount > 0 && (
              <span className="absolute -right-1 -top-1 flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--success)] opacity-70" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full border-2 border-[var(--surface)] bg-[var(--success)]" />
              </span>
            )}
          </IconBtn>

          <span className="mx-0.5 hidden h-6 w-px bg-[var(--border)] sm:block" />

          <UserMenu displayName={displayName} email={email} avatarUrl={avatarUrl} onReset={onReset} />
        </div>
      </div>
    </header>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 transition-colors hover:border-[var(--border-strong)]">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tone }} />
      <div>
        <p className="text-[13px] font-bold leading-none tabular-nums" style={{ color: tone }}>
          {value}
        </p>
        <p className="mt-0.5 whitespace-nowrap text-[9px] leading-none text-[var(--text-faint)]">
          {label}
        </p>
      </div>
    </div>
  );
}

function IconBtn({
  children,
  label,
  onClick,
  badge,
  className = "",
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  badge?: number;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`press relative grid h-9 min-w-9 place-items-center rounded-lg border border-[var(--border)] px-2 text-[var(--text-dim)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)] ${className}`}
    >
      {children}
      {badge !== undefined && badge > 0 && (
        <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-[var(--accent)] px-1 text-[9px] font-bold text-white tabular-nums">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}
