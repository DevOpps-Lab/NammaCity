import type { ReactNode } from "react";

/**
 * The console gets its own shell, not the citizen app's.
 *
 * No TabBar and no TopBar: this is a different product for a different reader,
 * and borrowing the citizen chrome would put "Report an issue" in front of
 * someone whose job is to answer them.
 *
 * The height dance is not decoration. `#app-root` in globals.css is
 * `position: fixed; inset: 0; display: flex; flex-direction: column;
 * overflow: hidden`, so a plain div here collapses instead of scrolling. Every
 * page under this root has to claim its height with `flex-1 min-h-0` and own
 * its own scroll container, the same way AuthShell does.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col bg-[var(--bg)]">{children}</div>;
}
