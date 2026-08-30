import type { ReactNode } from "react";

/**
 * Two-column auth shell.
 *
 * The left column is the argument, not decoration: anyone signing in should know
 * within a few seconds why this exists and is not just another complaint app.
 * Three published figures carry that on their own, so there is no illustration,
 * no glow and no chart behind them.
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
    <div className="scroll-thin flex flex-1 overflow-y-auto bg-[var(--bg)]">
      {/* --- argument column (desktop only) --- */}
      <aside className="hidden w-[46%] shrink-0 flex-col justify-between border-r border-[var(--border)] bg-[var(--surface)] p-10 lg:flex xl:p-14">
        <div>
          <Wordmark />
          <h2
            className="enter t-title mt-9 max-w-md"
            style={{ animationDelay: "80ms" }}
          >
            Filing a complaint is easy.{" "}
            <span className="text-[var(--text-dim)]">
              Getting it closed honestly is not.
            </span>
          </h2>
          <p
            className="enter t-sm measure mt-3.5 text-[var(--text-dim)]"
            style={{ animationDelay: "150ms" }}
          >
            Indian civic systems let the accused department close its own ticket.
            NammaCity holds a report open until a resident photographs the repair.
          </p>
        </div>

        <dl className="mt-10">
          {LEDGER.map((row, i) => (
            <div
              key={row.label}
              className="enter flex items-baseline justify-between gap-6 border-t border-[var(--border)] py-3.5 last:border-b"
              style={{ animationDelay: `${260 + i * 90}ms` }}
            >
              <div>
                <dt className="t-sm font-semibold">{row.label}</dt>
                <dd className="mt-0.5 text-[12px] leading-snug text-[var(--text-faint)]">
                  {row.detail}
                </dd>
              </div>
              <dd
                className="tnum shrink-0 text-[18px] font-semibold leading-none"
                style={{ color: row.color }}
              >
                {row.value}
              </dd>
            </div>
          ))}
        </dl>

        <p
          className="enter t-sm measure mt-6 text-[var(--text-faint)]"
          style={{ animationDelay: "560ms" }}
        >
          UK councils are not three times better than Indian municipal bodies.
          The difference is who is allowed to mark the ticket closed.
        </p>
      </aside>

      {/* --- form column --- */}
      <main className="flex min-w-0 flex-1 items-center justify-center px-5 py-10 sm:px-8">
        <div className="w-full max-w-[380px]">
          <div className="lg:hidden">
            <Wordmark />
          </div>

          <h1 className="enter t-display mt-9 lg:mt-0">{title}</h1>
          <p
            className="enter t-sm measure mb-7 mt-2 text-[var(--text-dim)]"
            style={{ animationDelay: "60ms" }}
          >
            {subtitle}
          </p>

          {children}

          <div
            className="enter mt-8 flex items-start gap-2.5 border-t border-[var(--border)] pt-5"
            style={{ animationDelay: "300ms" }}
          >
            <span
              aria-hidden
              className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded-[3px] border border-[var(--border-strong)] bg-black"
            />
            <p className="t-micro leading-relaxed">
              Faces and number plates are covered before anything is filed
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

const LEDGER = [
  {
    label: "BBMP Sahaaya, Bengaluru",
    detail: "11,785 complaints logged in five weeks. Six were resolved.",
    value: "0.05%",
    color: "var(--danger)",
  },
  {
    label: "FixMyStreet, United Kingdom",
    detail: "Measured independently, by the people who filed the reports.",
    value: "34%",
    color: "var(--success)",
  },
  {
    label: "Swachhata and MCD 311",
    detail: "Self reported by the departments that receive the complaints.",
    value: "93 to 95%",
    color: "var(--text-faint)",
  },
];

function Wordmark() {
  return (
    <div className="enter flex items-center gap-2.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-[8px] bg-[var(--accent)]">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M12 21s7-5.686 7-11a7 7 0 1 0-14 0c0 5.314 7 11 7 11Z"
            stroke="var(--on-accent)"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <circle cx="12" cy="10" r="2.5" fill="var(--on-accent)" />
        </svg>
      </span>
      <span className="text-[17px] font-bold tracking-tight text-[var(--text)]">
        NammaCity
      </span>
    </div>
  );
}
