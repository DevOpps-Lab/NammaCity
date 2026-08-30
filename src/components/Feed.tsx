"use client";

import { useMemo, useState } from "react";
import Icon from "./Icon";
import type { Report } from "@/lib/types";
import type { PublicPost } from "@/lib/db";
import { STATUS_STYLES, isBreached } from "@/lib/status";
import { now } from "@/lib/demoClock";

function ago(at: number): string {
  const ms = Math.max(0, now() - at);
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  return `${m}m ago`;
}

type Sort = "new" | "backed" | "overdue";
type Mode = "cases" | "namma";

/**
 * The public accountability feed. Two views:
 *   Cases        — every citizen's reports as an X-style card feed (anonymous).
 *   Namma Chennai — the public post timeline (@NammaChennai), real or simulated.
 *
 * Everyone can view and back any case; opening one routes through the existing
 * ReportSheet, which gates owner-only actions. Closure is community-verified
 * (photo), handled in the sheet.
 */
export default function Feed({
  reports,
  commentCounts,
  recentlyFixed,
  posts,
  onSelect,
  onSupport,
}: {
  reports: Report[];
  commentCounts: Record<string, number>;
  recentlyFixed: Report[];
  posts: PublicPost[];
  onSelect: (r: Report) => void;
  onSupport: (id: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("cases");
  const [sort, setSort] = useState<Sort>("new");

  const sorted = useMemo(() => {
    const list = [...reports];
    if (sort === "backed") list.sort((a, b) => b.supporters - a.supporters);
    else if (sort === "overdue")
      list.sort(
        (a, b) => Number(isBreached(b.status)) - Number(isBreached(a.status)) || a.slaDeadline - b.slaDeadline
      );
    else list.sort((a, b) => b.createdAt - a.createdAt);
    return list;
  }, [reports, sort]);

  return (
    <div className="scroll-thin pb-navbar h-full overflow-y-auto px-4 py-4">
      <div className="mx-auto w-full max-w-lg">
        {/* view toggle */}
        <div className="mb-3 flex gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-1">
          {(["cases", "namma"] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`flex-1 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors ${
                mode === m
                  ? "bg-[var(--accent)] text-[var(--on-accent)]"
                  : "text-[var(--text-dim)] hover:text-[var(--text)]"
              }`}
            >
              {m === "cases" ? "Cases" : "Namma Chennai"}
            </button>
          ))}
        </div>

        {mode === "namma" ? (
          <NammaTimeline posts={posts} />
        ) : (
          <>
            {/* recently fixed wins */}
            {recentlyFixed.length > 0 && (
              <div className="mb-4">
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--success)]">
                  Recently fixed
                </p>
                <div className="scroll-thin flex gap-2 overflow-x-auto pb-1">
                  {recentlyFixed.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => onSelect(r)}
                      className="shrink-0 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]"
                      style={{ width: 116 }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={r.afterPhotoUrl || r.photoUrl}
                        alt=""
                        className="h-16 w-full object-cover"
                      />
                      <p className="truncate px-2 py-1 text-left text-[10px] text-[var(--text-dim)]">
                        {r.place}
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* sort chips */}
            <div className="mb-3 flex gap-1.5">
              {(
                [
                  ["new", "Newest"],
                  ["backed", "Most backed"],
                  ["overdue", "Most overdue"],
                ] as [Sort, string][]
              ).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setSort(k)}
                  className={`rounded-full border px-3 py-1 text-[11px] font-medium transition-colors ${
                    sort === k
                      ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]"
                      : "border-[var(--border)] text-[var(--text-dim)] hover:border-[var(--border-strong)]"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {sorted.length === 0 ? (
              <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-6 text-center text-xs text-[var(--text-dim)]">
                No community reports yet.
              </p>
            ) : (
              <ul className="space-y-3">
                {sorted.map((r) => {
                  const st = STATUS_STYLES[r.status];
                  return (
                    <li
                      key={r.id}
                      className="card card-hover rise-in overflow-hidden"
                    >
                      <button onClick={() => onSelect(r)} className="block w-full text-left">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={r.photoUrl} alt="" className="h-44 w-full object-cover" />
                        <div className="p-3">
                          <div className="flex items-center gap-2">
                            <span
                              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
                              style={{ background: `${st.color}1a`, color: st.color }}
                            >
                              {st.hollow ? "○" : "●"} {st.label}
                            </span>
                            <span className="text-[10px] text-[var(--text-faint)]">
                              {ago(r.createdAt)}
                            </span>
                          </div>
                          <p className="mt-1.5 text-[13px] font-semibold capitalize">
                            {r.category.replace(/_/g, " ")}
                            <span className="ml-1 font-normal text-[var(--text-dim)]">
                              · {r.severity}
                            </span>
                          </p>
                          <p className="text-[11px] text-[var(--text-dim)]">
                            A resident · {r.place}
                          </p>
                        </div>
                      </button>
                      <div className="flex items-center gap-4 border-t border-[var(--border)] px-3 py-2">
                        <button
                          onClick={() => onSupport(r.id)}
                          className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-dim)] transition-colors hover:text-[var(--accent)]"
                        >
                          <Icon name="users" size={15} />
                          {r.supporters} back
                        </button>
                        <button
                          onClick={() => onSelect(r)}
                          className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-dim)] transition-colors hover:text-[var(--accent)]"
                        >
                          <Icon name="file-text" size={15} />
                          {commentCounts[r.id] ?? 0} comment
                          {(commentCounts[r.id] ?? 0) === 1 ? "" : "s"}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function NammaTimeline({ posts }: { posts: PublicPost[] }) {
  if (posts.length === 0) {
    return (
      <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-6 text-center text-xs text-[var(--text-dim)]">
        No public posts yet. Escalations and updates from @NammaChennai appear here.
      </p>
    );
  }
  return (
    <ul className="space-y-3">
      {posts.map((p) => (
        <li
          key={p.id}
          className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3"
        >
          <div className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-[var(--accent)]/12 text-[13px] font-bold text-[var(--accent)]">
              NC
            </span>
            <div className="min-w-0">
              <p className="text-[12px] font-semibold leading-tight">Namma Chennai</p>
              <p className="text-[10px] text-[var(--text-faint)]">
                @NammaChennai · {ago(p.at)} ·{" "}
                {p.source === "bluesky" ? (
                  <span className="text-[var(--accent)]">posted to Bluesky</span>
                ) : p.source === "x" ? (
                  <span className="text-[var(--accent)]">posted to X</span>
                ) : (
                  "simulated"
                )}
              </p>
            </div>
          </div>
          <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--text)]">
            {p.body}
          </p>
          {p.tweetUrl && (
            <a
              href={p.tweetUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1.5 inline-block text-[11px] font-medium text-[var(--accent)]"
            >
              View post ↗
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}
