"use client";

import Icon, { type IconName } from "./Icon";

export type TabKey = "report" | "reports" | "feed" | "map";

const TABS: { key: TabKey; label: string; icon: IconName }[] = [
  { key: "report", label: "Report", icon: "camera" },
  { key: "reports", label: "My Reports", icon: "file-text" },
  { key: "feed", label: "Feed", icon: "users" },
  { key: "map", label: "Map", icon: "map" },
];

/**
 * Primary navigation. One component renders both trees CSS-responsively —
 * bottom bar on phones, left rail from lg up — matching the convention already
 * used for the agent trace.
 *
 * Rendered as an IN-FLOW flex sibling, not a floating overlay. That matters:
 * `#app-root` is `position: fixed`, so it is the containing block for every
 * `absolute` overlay in the app. A floating bar would be covered by all five
 * modals and would collide with the FAB and the Recently Fixed rail, both of
 * which sit at `bottom-0`. Because this reserves real layout height instead,
 * the collision cannot happen and no z-index juggling is required.
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
      {/* --- mobile: bottom bar (Floating Pill) --- */}
      <nav
        aria-label="Main"
        className="pb-safe px-safe absolute bottom-0 inset-x-0 z-[var(--z-panel)] shrink-0 lg:hidden p-4 pointer-events-none"
      >
        <ul className="flex overflow-hidden rounded-2xl border border-[var(--border)] bg-white/75 backdrop-blur-xl shadow-lg pointer-events-auto">
          {TABS.map((t) => {
            const on = t.key === active;
            return (
              <li key={t.key} className="flex-1">
                <button
                  onClick={() => onChange(t.key)}
                  aria-current={on ? "page" : undefined}
                  className={`press active:scale-95 relative flex h-14 w-full flex-col items-center justify-center gap-0.5 transition-all duration-200 ${
                    on ? "text-[var(--accent)]" : "text-slate-500 hover:text-slate-800"
                  }`}
                >
                  <span className="relative">
                    <Icon name={t.icon} size={20} />
                    {t.key === "reports" && badge ? <Dot count={badge} /> : null}
                  </span>
                  <span className="text-[10px] font-medium">{t.label}</span>
                  {on && (
                    <span className="absolute inset-x-6 top-0 h-1 rounded-b-md bg-[var(--accent)] shadow-[0_2px_8px_rgba(var(--accent-rgb),0.5)]" />
                  )}
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
              className={`press relative flex h-11 items-center gap-3 rounded-xl px-3 transition-all xl:px-3.5 ${
                on
                  ? "bg-[var(--accent-soft)] text-[var(--accent)] shadow-[var(--shadow-1)]"
                  : "text-[var(--text-dim)] hover:bg-[var(--hover-overlay)] hover:text-[var(--text)]"
              }`}
            >
              {on && (
                <span className="absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-[var(--accent)]" />
              )}
              <span className="relative shrink-0">
                <Icon name={t.icon} size={19} />
                {t.key === "reports" && badge ? <Dot count={badge} /> : null}
              </span>
              <span
                className={`hidden text-[13px] xl:inline ${on ? "font-semibold" : "font-medium"}`}
              >
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
    <span className="absolute -right-2 -top-1.5 grid h-4 min-w-4 place-items-center rounded-full bg-[var(--danger)] px-1 text-[9px] font-bold tabular-nums text-white">
      {count > 99 ? "99+" : count}
    </span>
  );
}
