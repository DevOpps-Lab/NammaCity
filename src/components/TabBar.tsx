"use client";

import Icon, { type IconName } from "./Icon";

export type TabKey = "report" | "dashcam" | "reports" | "feed" | "map";

const TABS: { key: TabKey; label: string; icon: IconName }[] = [
  { key: "report", label: "Report", icon: "camera" },
  { key: "dashcam", label: "Dashcam", icon: "video" },
  { key: "reports", label: "Reports", icon: "file-text" },
  { key: "feed", label: "Feed", icon: "users" },
  { key: "map", label: "Map", icon: "map" },
];

/**
 * Primary navigation. One component renders both trees CSS-responsively — a
 * bottom bar on phones, a left rail from lg up.
 *
 * The mobile nav is absolutely positioned over the content (pointer-events
 * scoped to the bar itself) rather than reserving flow height, because
 * `#app-root` is `position: fixed` and every overlay in the app is scoped to
 * the content row. Each tab surface leaves bottom room for it.
 */
export default function TabBar({
  active,
  onChange,
  badge,
}: {
  active: TabKey;
  onChange: (t: TabKey) => void;
  /** Count shown on My Reports — reports needing the citizen's attention. */
  badge?: number;
}) {
  return (
    <>
      {/* --- mobile: bottom bar --- */}
      <nav
        aria-label="Main"
        className="pb-safe-3 px-safe pointer-events-none absolute inset-x-0 bottom-0 z-[var(--z-panel)] shrink-0 p-3 lg:hidden"
      >
        <ul className="pointer-events-auto grid grid-cols-5 overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface)]/90 shadow-[var(--shadow-2)] backdrop-blur-xl">
          {TABS.map((t) => {
            const on = t.key === active;
            return (
              <li key={t.key}>
                <button
                  onClick={() => onChange(t.key)}
                  aria-current={on ? "page" : undefined}
                  className={`press relative flex h-[58px] w-full flex-col items-center justify-center gap-1 ${
                    on ? "text-[var(--accent)]" : "text-[var(--text-faint)] hover:text-[var(--text)]"
                  }`}
                >
                  {on && (
                    <span
                      aria-hidden
                      className="absolute inset-x-5 top-0 h-[2px] bg-[var(--accent)]"
                    />
                  )}
                  <span className="relative">
                    <Icon name={t.icon} size={19} />
                    {t.key === "reports" && badge ? <Dot count={badge} /> : null}
                  </span>
                  <span className={`whitespace-nowrap text-[11px] ${on ? "font-bold" : "font-medium"}`}>
                    {t.label}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* --- desktop: left rail --- */}
      <nav
        aria-label="Main"
        className="hidden shrink-0 border-r border-[var(--border)] bg-[var(--surface)] p-2 lg:flex lg:w-[76px] lg:flex-col lg:gap-1 xl:w-[196px]"
      >
        {TABS.map((t) => {
          const on = t.key === active;
          return (
            <button
              key={t.key}
              onClick={() => onChange(t.key)}
              aria-current={on ? "page" : undefined}
              title={t.label}
              className={`press relative flex h-11 items-center gap-3 rounded-[var(--radius-control)] px-3 transition-colors xl:px-3.5 ${
                on
                  ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                  : "text-[var(--text-dim)] hover:bg-[var(--hover-overlay)] hover:text-[var(--text)]"
              }`}
            >
              {on && (
                <span
                  aria-hidden
                  className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r bg-[var(--accent)]"
                />
              )}
              <span className="relative shrink-0">
                <Icon name={t.icon} size={19} />
                {t.key === "reports" && badge ? <Dot count={badge} /> : null}
              </span>
              <span className={`hidden text-[13px] xl:inline ${on ? "font-bold" : "font-medium"}`}>
                {t.label}
              </span>
            </button>
          );
        })}
      </nav>
    </>
  );
}

function Dot({ count }: { count: number }) {
  return (
    <span className="tnum absolute -right-2 -top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-[var(--accent)] px-1 text-[10px] font-bold text-[var(--on-accent)]">
      {count > 99 ? "99+" : count}
    </span>
  );
}
