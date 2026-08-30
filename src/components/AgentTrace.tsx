"use client";

import { useEffect, useRef } from "react";
import type { TraceLine } from "@/lib/types";
import Icon from "./Icon";

/**
 * The agents do the interesting work and every bit of it is invisible without
 * this. Streaming the reasoning turns backend plumbing into the thing people
 * actually watch.
 *
 * Rendered as a rail: one node per step, connected by a hairline, agent name as
 * a mono micro-label, the message below it. Refusals land here in danger red so
 * a jurisdiction the app would not guess is visible rather than silent.
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

  const running = lines.length > 0;

  return (
    <div className="flex h-full flex-col border-l border-[var(--border)] bg-[var(--surface)]">
      <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-[var(--border)] px-4">
        <span className="relative flex h-2 w-2">
          {running && (
            <span
              aria-hidden
              className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--success)] opacity-70"
            />
          )}
          <span
            aria-hidden
            className="relative inline-flex h-2 w-2 rounded-full"
            style={{ background: running ? "var(--success)" : "var(--text-faint)" }}
          />
        </span>
        <div>
          <h2 className="t-head leading-none">Agent trace</h2>
          <p className="t-micro mt-1 leading-none">
            {running ? `Live · ${lines.length} steps` : "Idle"}
          </p>
        </div>

        <div className="ml-auto flex items-center gap-1">
          <button onClick={onClear} className="btn btn-ghost min-h-9 px-2.5 text-[12px] font-medium">
            Clear
          </button>
          {onClose && (
            <button
              onClick={onClose}
              aria-label="Close agent trace"
              className="grid h-10 w-10 place-items-center rounded-[var(--radius-control)] text-[var(--text-faint)] hover:bg-[var(--hover-overlay)] hover:text-[var(--text)]"
            >
              <Icon name="close" size={17} />
            </button>
          )}
        </div>
      </header>

      <div className="scroll-thin flex-1 overflow-y-auto px-4 py-4">
        {lines.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2.5 px-6 text-center">
            <span aria-hidden className="text-[var(--text-faint)]">
              <Icon name="activity" size={22} />
            </span>
            <p className="t-body font-medium text-[var(--text-dim)]">No activity yet</p>
            <p className="t-sm measure text-[var(--text-faint)]">
              Report an issue and each agent&apos;s reasoning streams here as it runs.
            </p>
          </div>
        ) : (
          <ol>
            {lines.map((l, i) => {
              // Keyed by index deliberately: lines are append-only, so the
              // index is stable and each new row animates in exactly once.
              const last = i === lines.length - 1;
              const tone =
                l.status === "warn"
                  ? "var(--warning)"
                  : l.status === "ok"
                    ? "var(--success)"
                    : "var(--text)";
              return (
                <li key={i} className="slide-in relative flex gap-3 pb-4 last:pb-1">
                  {!last && (
                    <span
                      aria-hidden
                      className="absolute left-[5px] top-4 bottom-0 w-px bg-[var(--border)]"
                    />
                  )}
                  <span
                    aria-hidden
                    className="relative z-10 mt-[5px] h-[11px] w-[11px] shrink-0 rounded-full"
                    style={{
                      background: last && running ? AGENT_COLOR[l.agent] : "transparent",
                      border: `2px solid ${AGENT_COLOR[l.agent]}`,
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <p
                      className="t-micro leading-none"
                      style={{ color: AGENT_COLOR[l.agent], letterSpacing: "0.14em" }}
                    >
                      {l.agent}
                    </p>
                    <p className="t-sm mt-1.5" style={{ color: tone }}>
                      {l.text}
                      {l.ms !== undefined && (
                        <span className="tnum ml-1.5 text-[var(--text-faint)]">{l.ms}ms</span>
                      )}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        <div ref={endRef} />
      </div>

      <p className="t-micro border-t border-[var(--border)] px-4 py-3.5 leading-relaxed">
        Refusals appear here too. A jurisdiction the app cannot resolve is logged,
        never guessed.
      </p>
    </div>
  );
}
