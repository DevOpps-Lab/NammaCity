"use client";

import { useEffect, useRef } from "react";
import type { TraceLine } from "@/lib/types";
import Icon from "./Icon";

/**
 * The agents do the interesting work and every bit of it is invisible without
 * this. Streaming the reasoning turns backend plumbing into the thing people
 * actually watch.
 */

const AGENT_COLOR: Record<TraceLine["agent"], string> = {
  TRIAGE: "var(--warning)",
  ROUTING: "var(--accent)",
  AUTHORITY: "var(--violet)",
  SLA: "#3fb6d8",
  FILING: "var(--success)",
  GUARD: "var(--danger)",
};

export default function AgentTrace({
  lines,
  onClear,
  onClose,
}: {
  lines: TraceLine[];
  onClear: () => void;
  onClose?: () => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [lines.length]);

  return (
    <div className="flex h-full flex-col border-l border-[var(--border)] bg-[var(--surface)]">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
        <span className="relative flex h-2 w-2">
          {lines.length > 0 && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--success)] opacity-70" />
          )}
          <span
            className="relative inline-flex h-2 w-2 rounded-full"
            style={{ background: lines.length ? "var(--success)" : "var(--text-faint)" }}
          />
        </span>
        <h2 className="text-[11px] font-semibold tracking-[0.12em] text-[var(--text-dim)]">
          AGENT TRACE
        </h2>

        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={onClear}
            className="rounded-md px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-[var(--text-faint)] transition-colors hover:bg-[var(--hover-overlay)] hover:text-[var(--text)]"
          >
            Clear
          </button>
          {onClose && (
            <button
              onClick={onClose}
              aria-label="Close agent trace"
              className="grid h-8 w-8 place-items-center rounded-md text-[var(--text-faint)] hover:bg-[var(--hover-overlay)] hover:text-[var(--text)]"
            >
              <Icon name="close" size={16} />
            </button>
          )}
        </div>
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto px-3 py-3">
        {lines.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <span className="text-[var(--text-faint)]">
              <Icon name="activity" size={22} />
            </span>
            <p className="text-xs text-[var(--text-dim)]">No activity yet</p>
            <p className="text-[11px] leading-relaxed text-[var(--text-faint)]">
              Report an issue and each agent&apos;s reasoning streams here as it runs.
            </p>
          </div>
        ) : (
          <ol className="space-y-1.5 font-mono text-[11px] leading-relaxed">
            {lines.map((l, i) => (
              // Keyed by index deliberately: lines are append-only, so the
              // index is stable and each new row animates in exactly once.
              <li key={i} className="slide-in flex gap-2">
                <span
                  className="w-[68px] shrink-0 font-semibold"
                  style={{ color: AGENT_COLOR[l.agent] }}
                >
                  {l.agent}
                </span>
                <span
                  className={
                    l.status === "warn"
                      ? "min-w-0 flex-1 text-[var(--warning)]"
                      : l.status === "ok"
                        ? "min-w-0 flex-1 text-[var(--success)]"
                        : "min-w-0 flex-1 text-[var(--text)]"
                  }
                >
                  {l.text}
                  {l.ms !== undefined && (
                    <span className="ml-1.5 tabular-nums text-[var(--text-faint)]">
                      {l.ms}ms
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
