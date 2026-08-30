"use client";

import Icon from "./Icon";
import UserMenu from "./UserMenu";

interface Props {
  stats: {
    open: number;
    breached: number;
    verified: number;
    fixRate: number;
    claimedRate: number;
  };
  demo: boolean;
  outboxCount: number;
  displayName: string;
  email: string;
  avatarUrl?: string | null;
  onToggleDemo: () => void;
  onOpenOutbox: () => void;
  onToggleTrace: () => void;
  onReset: () => void;
  onSeed: () => void;
  /** Number of agent-trace lines — drives the live dot on the trace button. */
  traceCount: number;
}

export default function TopBar({
  stats,
  demo,
  outboxCount,
  displayName,
  email,
  avatarUrl,
  onToggleDemo,
  onOpenOutbox,
  onToggleTrace,
  onReset,
  onSeed,
  traceCount,
}: Props) {
  return (
    // pt-safe keeps the bar clear of the Dynamic Island while the surface
    // colour still fills the notch area, so there's no seam above the header.
    <header className="pt-safe px-safe relative z-[var(--z-overlay)] shrink-0 border-b border-[var(--border)] bg-[var(--surface)]/92 backdrop-blur-xl">
      <div className="flex h-14 items-center gap-1.5 px-2 sm:gap-2 sm:px-4">
        <div className="flex shrink-0 items-center gap-2">
          <span
            aria-hidden
            className="grid h-8 w-8 place-items-center rounded-[var(--radius-control)] bg-[var(--accent)] text-[var(--on-accent)]"
          >
            <Icon name="shield" size={17} />
          </span>
          <div>
            <p className="text-[13px] font-bold leading-none tracking-tight">NammaCity</p>
            <p className="t-micro mt-1 leading-none">Chennai</p>
          </div>
        </div>

        {/*
          Counts start at `sm`, not at 0.

          At 390px this rail needed ~175px and had ~105px, and because it was
          `overflow-x-auto no-bar` the overflow became an invisible scroll: the
          "Past SLA" chip was clipped mid-word with no affordance at all. The
          numbers are not lost, they are hosted properly. My Reports opens with
          the verified-against-claimed pair at 26px, which is the comparison
          this product exists to make, and a 68px chip was the worst possible
          place to make it.
        */}
        <div className="ml-1 hidden min-w-0 items-center gap-1.5 sm:flex">
          <Stat label="Open" value={stats.open} tone="var(--accent)" />
          <Stat label="Past SLA" value={stats.breached} tone="var(--danger)" />
          <Stat
            label="Verified"
            value={stats.verified}
            tone="var(--success)"
            className="hidden min-[560px]:flex"
          />
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {/* Verified fix rate, desktop only. The full verified-vs-claimed pair
              lives at the top of My Reports, which is where a phone sees it. */}
          <p
            className="tnum mr-1.5 hidden text-[15px] font-bold leading-none text-[var(--success)] md:block"
            title={`${stats.fixRate}% of reports have been closed on a citizen's photograph. ${stats.claimedRate}% were merely claimed fixed by the authority.`}
            aria-label={`Citizen-verified fix rate ${stats.fixRate} percent, against ${stats.claimedRate} percent claimed by authorities`}
          >
            {stats.fixRate}%
          </p>

          <IconBtn label="Open outbox" onClick={onOpenOutbox} badge={outboxCount}>
            <Icon name="inbox" size={17} />
          </IconBtn>

          <button
            onClick={onToggleDemo}
            aria-pressed={demo}
            title="Compress time so deadlines arrive during a demo"
            className={`press flex h-10 items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 text-[12px] font-semibold transition-colors ${
              demo
                ? "bg-[var(--warning)] text-[var(--on-accent)]"
                : "border border-[var(--border)] text-[var(--text-dim)] hover:border-[var(--border-strong)] hover:text-[var(--text)]"
            }`}
          >
            <Icon name="clock" size={15} />
            <span className="hidden sm:inline">{demo ? "1s = 1h" : "Demo"}</span>
          </button>

          <IconBtn label="Agent trace" onClick={onToggleTrace}>
            <Icon name="activity" size={17} />
            {traceCount > 0 && (
              <span
                aria-hidden
                className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-[var(--surface)] bg-[var(--success)]"
              />
            )}
          </IconBtn>

          <span aria-hidden className="mx-0.5 hidden h-6 w-px bg-[var(--border)] sm:block" />

          <UserMenu
            displayName={displayName}
            email={email}
            avatarUrl={avatarUrl}
            onReset={onReset}
            onSeed={onSeed}
          />
        </div>
      </div>
    </header>
  );
}

function Stat({
  label,
  value,
  tone,
  className = "",
}: {
  label: string;
  value: number;
  tone: string;
  className?: string;
}) {
  return (
    <div
      className={`flex shrink-0 items-center gap-1.5 rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 sm:px-2.5 ${className}`}
    >
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tone }} />
      <div>
        <p className="tnum text-[13px] font-bold leading-none" style={{ color: tone }}>
          {value}
        </p>
        <p className="t-micro mt-1 whitespace-nowrap leading-none">{label}</p>
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
      className={`press relative grid h-10 min-w-10 place-items-center rounded-[var(--radius-control)] border border-[var(--border)] px-2 text-[var(--text-dim)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)] ${className}`}
    >
      {children}
      {badge !== undefined && badge > 0 && (
        <span className="tnum absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-[var(--accent)] px-1 text-[10px] font-bold text-[var(--on-accent)]">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}
