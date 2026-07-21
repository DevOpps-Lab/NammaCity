"use client";

import { useEffect, useState } from "react";
import Icon from "./Icon";
import type { Comment } from "@/lib/db";
import { now } from "@/lib/demoClock";

/** Compact "time ago" for a past instant, on the demo or real clock. */
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

/**
 * Anonymous, community comment thread on a case. Identity is never shown —
 * "A resident · <area>" preserves the app's privacy stance while still being
 * social. Backing (support) is separate; this is discussion.
 */
export default function CommentThread({
  reportId,
  area,
  fetchComments,
  onAdd,
}: {
  reportId: string;
  area: string;
  fetchComments: (reportId: string) => Promise<Comment[]>;
  onAdd: (reportId: string, body: string) => Promise<void>;
}) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = () =>
    fetchComments(reportId)
      .then(setComments)
      .catch(() => setComments([]));

  // setState only happens inside the async .then/.catch (after the await), so
  // there is no synchronous setState in the effect body.
  useEffect(() => {
    let active = true;
    fetchComments(reportId)
      .then((list) => active && (setComments(list), setLoading(false)))
      .catch(() => active && (setComments([]), setLoading(false)));
    return () => {
      active = false;
    };
  }, [reportId, fetchComments]);

  const submit = async () => {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    // Optimistic append.
    const optimistic: Comment = {
      id: `tmp-${now()}`,
      reportId,
      author: "me",
      authorArea: area,
      at: now(),
      body,
    };
    setComments((c) => [...c, optimistic]);
    setDraft("");
    try {
      await onAdd(reportId, body);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-faint)]">
        Community ({comments.length})
      </p>

      {loading ? (
        <p className="text-[11px] text-[var(--text-faint)]">Loading…</p>
      ) : comments.length === 0 ? (
        <p className="text-[11px] text-[var(--text-faint)]">
          No comments yet. Be the first resident to weigh in.
        </p>
      ) : (
        <ul className="space-y-2">
          {comments.map((c) => (
            <li
              key={c.id}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2"
            >
              <p className="text-[10px] text-[var(--text-faint)]">
                A resident{c.authorArea ? ` · ${c.authorArea}` : ""} · {ago(c.at)}
              </p>
              <p className="mt-0.5 whitespace-pre-wrap text-[12px] leading-snug text-[var(--text)]">
                {c.body}
              </p>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex items-end gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
          }}
          rows={2}
          maxLength={500}
          placeholder="Add a comment (⌘/Ctrl+Enter to post)…"
          className="min-w-0 flex-1 resize-none rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[12px] outline-none focus:border-[var(--accent)]"
        />
        <button
          onClick={submit}
          disabled={busy || !draft.trim()}
          aria-label="Post comment"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--accent)] text-[var(--on-accent)] transition active:scale-95 disabled:opacity-40"
        >
          <Icon name="send" size={15} />
        </button>
      </div>
    </div>
  );
}
