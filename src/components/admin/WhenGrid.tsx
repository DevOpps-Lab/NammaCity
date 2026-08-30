"use client";

import { useMemo } from "react";
import type { WhenCell } from "@/lib/admin-data";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * When the city reports, by hour and weekday, in local time.
 *
 * Built on reports.inserted_at, which Postgres writes, and NOT on created_at.
 * created_at is a client-supplied epoch passed through a demo clock that turns
 * one real second into one simulated hour, and nothing records whether that
 * clock was running. A peak-hours chart drawn on it would be an artefact of
 * whoever last ran a demo.
 */
export default function WhenGrid({ cells, loading }: { cells: WhenCell[]; loading: boolean }) {
  const { grid, max, total, peak } = useMemo(() => {
    const g: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
    let m = 0;
    let t = 0;
    let pk = { dow: 0, hour: 0, n: 0 };
    for (const c of cells) {
      if (c.dow < 0 || c.dow > 6 || c.hour < 0 || c.hour > 23) continue;
      g[c.dow][c.hour] = c.n;
      t += c.n;
      if (c.n > m) m = c.n;
      if (c.n > pk.n) pk = { dow: c.dow, hour: c.hour, n: c.n };
    }
    return { grid: g, max: m, total: t, peak: pk };
  }, [cells]);

  if (loading) {
    return (
      <div className="panel p-4">
        <div className="shimmer h-5 w-48 rounded" />
        <div className="shimmer mt-5 h-40 w-full rounded" />
      </div>
    );
  }

  if (!total) {
    return (
      <div className="panel p-8 text-center">
        <p className="t-body">Nothing filed in this period.</p>
      </div>
    );
  }

  return (
    <section className="panel p-4">
      <h2 className="t-head">When reports arrive</h2>
      <p className="t-sm mt-1 text-[var(--text-dim)]">
        Local time. Busiest slot is {DAYS[peak.dow]} at {label(peak.hour)}, with{" "}
        <span className="tnum">{peak.n.toLocaleString()}</span> reports.
      </p>

      <div className="mt-4 overflow-x-auto scroll-thin">
        <div className="min-w-[560px]">
          <div className="grid grid-cols-[34px_repeat(24,1fr)] gap-[2px]">
            <span />
            {Array.from({ length: 24 }, (_, h) => (
              <span
                key={h}
                className="tnum text-center text-[9px] leading-none text-[var(--text-faint)]"
              >
                {h % 3 === 0 ? h : ""}
              </span>
            ))}

            {DAYS.map((d, dow) => (
              <Row key={d} day={d} counts={grid[dow]} max={max} />
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-2 border-t border-[var(--border)] pt-3">
        <span className="text-[12px] text-[var(--text-faint)]">Fewer</span>
        {[0.08, 0.3, 0.55, 0.8, 1].map((s) => (
          <span
            key={s}
            aria-hidden
            className="h-3 w-6 rounded-[3px]"
            style={{ background: shade(s) }}
          />
        ))}
        <span className="text-[12px] text-[var(--text-faint)]">More</span>
        <span className="tnum ml-auto text-[12px] text-[var(--text-faint)]">
          {total.toLocaleString()} reports
        </span>
      </div>
    </section>
  );
}

function Row({ day, counts, max }: { day: string; counts: number[]; max: number }) {
  return (
    <>
      <span className="flex items-center text-[11px] text-[var(--text-faint)]">{day}</span>
      {counts.map((n, h) => (
        <span
          key={h}
          title={`${day} ${label(h)}: ${n} report${n === 1 ? "" : "s"}`}
          className="aspect-square rounded-[3px]"
          style={{ background: n ? shade(n / max) : "var(--surface-2)" }}
        />
      ))}
    </>
  );
}

/**
 * One hue, varying in lightness. A rainbow scale would imply the categories are
 * different in kind rather than in amount, and would fall apart for anyone with
 * a colour vision deficiency.
 */
function shade(t: number) {
  const clamped = Math.max(0.08, Math.min(1, t));
  return `color-mix(in srgb, var(--accent) ${Math.round(clamped * 100)}%, var(--surface-2))`;
}

function label(h: number) {
  const suffix = h < 12 ? "am" : "pm";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${suffix}`;
}
