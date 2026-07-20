"use client";

import type { Report } from "@/lib/types";
import { t, type Lang } from "@/lib/i18n";

/**
 * A feed of nothing but complaints is demoralising and people leave.
 *
 * Sjoberg, Mellon & Peixoto (Public Administration Review, 2017; n=399,364
 * FixMyStreet users) found a successful first experience raises the odds of a
 * second report by ~54-57%, and a failed one loses the user more or less
 * permanently. Wins are a retention mechanism, not decoration.
 */
export default function RecentlyFixed({
  reports,
  lang,
  onSelect,
}: {
  reports: Report[];
  lang: Lang;
  onSelect: (r: Report) => void;
}) {
  if (reports.length === 0) return null;

  return (
    <div
      style={{ "--pb": "0.75rem" } as React.CSSProperties}
      className="pb-safe pointer-events-auto absolute inset-x-0 bottom-0 z-10 px-3"
    >
      <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-700">
        {t(lang, "recentlyFixed")}
      </p>
      <div className="flex gap-2 overflow-x-auto scroll-thin pb-1">
        {reports.map((r, i) => (
          <button
            key={r.id}
            onClick={() => onSelect(r)}
            style={{ animationDelay: `${Math.min(i * 70, 560)}ms` }}
            className="rise-in lift flex w-40 shrink-0 flex-col rounded-xl border border-emerald-500/25 bg-[var(--surface)]/95 p-2 text-left backdrop-blur hover:border-emerald-500/60"
          >
            <div className="mb-1.5 flex gap-1">
              <Thumb src={r.photoUrl} label="before" />
              <Thumb src={r.afterPhotoUrl} label="after" fixed />
            </div>
            <p className="truncate text-[11px] font-semibold">{r.place}</p>
            <p className="truncate text-[9px] text-[var(--text-dim)]">
              {r.category.replace(/_/g, " ")} · {r.supporters} voices
            </p>
          </button>
        ))}
      </div>
    </div>
  );
}

function Thumb({
  src,
  label,
  fixed,
}: {
  src?: string;
  label: string;
  fixed?: boolean;
}) {
  return (
    <div className="relative h-12 flex-1 overflow-hidden rounded-md bg-[var(--surface-2)]">
      {src && src.startsWith("data:") ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={label} className="h-full w-full object-cover" />
      ) : (
        <div
          className={`grid h-full w-full place-items-center text-[8px] ${
            fixed ? "text-emerald-700" : "text-[var(--text-dim)]"
          }`}
        >
          {label}
        </div>
      )}
      <span className="absolute bottom-0 left-0 bg-black/70 px-1 text-[7px] uppercase tracking-wider text-white">
        {label}
      </span>
    </div>
  );
}
