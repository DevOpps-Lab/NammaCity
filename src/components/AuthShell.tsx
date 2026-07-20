import type { ReactNode } from "react";

/**
 * Two-column auth shell.
 *
 * The left column is not decoration — it's the argument. Anyone signing in
 * should know within five seconds why this exists and isn't just another
 * complaint app, so the measured resolution gap leads.
 */
export default function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="scroll-thin flex flex-1 overflow-y-auto">
      {/* --- argument column (desktop only) --- */}
      <aside className="relative hidden w-[46%] shrink-0 flex-col justify-between overflow-hidden border-r border-[var(--border)] bg-[var(--surface)] p-10 lg:flex xl:p-14">
        {/* Slow-drifting glow behind the grid. Transform-only, so it composites
            on the GPU and costs nothing on a laptop driving a projector. */}
        <div
          aria-hidden
          className="drift pointer-events-none absolute -left-1/4 -top-1/3 h-[70%] w-[90%] rounded-full opacity-40 blur-3xl"
          style={{
            background:
              "radial-gradient(circle, color-mix(in srgb, var(--accent) 42%, transparent) 0%, transparent 68%)",
          }}
        />

        {/* subtle map-grid texture */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.22]"
          style={{
            backgroundImage:
              "linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)",
            backgroundSize: "44px 44px",
            maskImage: "radial-gradient(ellipse at 30% 20%, black, transparent 72%)",
          }}
        />

        <div className="relative">
          <div className="rise-in">
            <Wordmark />
          </div>
          <p
            className="rise-in mt-8 max-w-md text-[22px] font-semibold leading-snug text-[var(--text)] xl:text-[26px]"
            style={{ animationDelay: "80ms" }}
          >
            Filing a complaint is solved.
            <br />
            <span className="text-[var(--text-dim)]">
              Getting it actually fixed is not.
            </span>
          </p>
          <p
            className="rise-in mt-4 max-w-md text-[13px] leading-relaxed text-[var(--text-dim)]"
            style={{ animationDelay: "160ms" }}
          >
            Indian civic systems let the accused department close its own ticket.
            CivicAgent makes closure verifiable by the citizen instead — and
            attaches consequence to silence.
          </p>
        </div>

        <div className="relative mt-10">
          <p
            className="rise-in mb-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-faint)]"
            style={{ animationDelay: "240ms" }}
          >
            Measured resolution rates
          </p>
          <StatRow
            label="BBMP Sahaaya, Bengaluru"
            detail="11,785 reported · 6 resolved"
            value="0.05%"
            tone="danger"
            width={1}
            delay={320}
          />
          <StatRow
            label="FixMyStreet UK"
            detail="independently measured"
            value="34%"
            tone="accent"
            width={34}
            delay={420}
          />
          <StatRow
            label="Swachhata / MCD 311"
            detail="self-reported by the authority"
            value="93–95%"
            tone="dim"
            width={94}
            dashed
            delay={520}
          />
          <p
            className="rise-in mt-4 max-w-md text-[11px] leading-relaxed text-[var(--text-faint)]"
            style={{ animationDelay: "640ms" }}
          >
            UK councils are not three times better than Indian ULBs. The
            difference is who is allowed to mark the ticket closed.
          </p>
        </div>
      </aside>

      {/* --- form column --- */}
      <main className="flex min-w-0 flex-1 items-center justify-center px-5 py-10 sm:px-8">
        <div className="w-full max-w-[380px]">
          <div className="rise-in lg:hidden">
            <Wordmark />
          </div>

          <h1 className="rise-in mt-8 text-[26px] font-bold tracking-tight text-[var(--text)] lg:mt-0">
            {title}
          </h1>
          <p
            className="rise-in mb-7 mt-1.5 text-[13px] leading-relaxed text-[var(--text-dim)]"
            style={{ animationDelay: "60ms" }}
          >
            {subtitle}
          </p>

          {children}

          <p
            className="rise-in mt-8 border-t border-[var(--border)] pt-5 text-[11px] leading-relaxed text-[var(--text-faint)]"
            style={{ animationDelay: "300ms" }}
          >
            Demo build. Nothing is sent to a real government address — complaints
            are composed in full and routed to a sandboxed inbox.
          </p>
        </div>
      </main>
    </div>
  );
}

function Wordmark() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent)]">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M12 21s7-5.686 7-11a7 7 0 1 0-14 0c0 5.314 7 11 7 11Z"
            stroke="white"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <circle cx="12" cy="10" r="2.5" fill="white" />
        </svg>
      </span>
      <span className="text-[17px] font-bold tracking-tight text-[var(--text)]">
        CivicAgent
      </span>
    </div>
  );
}

function StatRow({
  label,
  detail,
  value,
  tone,
  width,
  dashed,
  delay = 0,
}: {
  label: string;
  detail: string;
  value: string;
  tone: "danger" | "accent" | "dim";
  width: number;
  dashed?: boolean;
  delay?: number;
}) {
  const color =
    tone === "danger"
      ? "var(--danger)"
      : tone === "accent"
        ? "var(--success)"
        : "var(--text-faint)";

  return (
    <div className="rise-in mb-3" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[12px] font-medium text-[var(--text)]">{label}</span>
        <span
          className="font-mono text-[12px] font-semibold tabular-nums"
          style={{ color }}
        >
          {value}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-3)]">
        {/* The bar grows to its measured value — the 0.05% vs 34% gap is the
            argument, so letting it draw makes the contrast land. */}
        <div
          className="grow-bar h-full rounded-full"
          style={{
            width: `${Math.max(width, 1.5)}%`,
            animationDelay: `${delay + 120}ms`,
            background: dashed
              ? `repeating-linear-gradient(90deg, ${color} 0 5px, transparent 5px 9px)`
              : color,
            opacity: dashed ? 0.7 : 1,
          }}
        />
      </div>
      <p className="mt-1 text-[10.5px] text-[var(--text-faint)]">{detail}</p>
    </div>
  );
}
