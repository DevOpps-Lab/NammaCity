"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import type { Report, ReportStatus, TraceLine, TimelineEvent } from "./types";
import { createClient } from "./supabase/client";
import * as db from "./db";
import { now, setDemoMode, isDemoMode } from "./demoClock";
import { isOpen, isBreached } from "./status";
import type { OutboxItem } from "./outbox";
import { composeReply } from "./outbox";
import { classifyReply, applyReply, type InboundReply } from "./correspondence";
import type { Lang } from "./i18n";

/**
 * Client store backed by Postgres.
 *
 * Mutations are OPTIMISTIC: local state moves immediately, the write goes out
 * behind it, and a failure refetches to resync. A civic report where the pin
 * doesn't move until a round-trip completes feels broken on Indian mobile data,
 * and the demo clock ticks faster than a network call.
 *
 * The SLA sweep is deliberately doubled: locally for the countdown rings (250ms,
 * no network) and in Postgres for durability. Postgres is the authority on what
 * a state transition MEANS; the client is only the authority on how it looks.
 */
export function useCivicStore() {
  const supabase = useMemo(() => createClient(), []);

  const [user, setUser] = useState<User | null>(null);
  const [displayName, setDisplayName] = useState<string>("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [trace, setTrace] = useState<TraceLine[]>([]);
  const [lang, setLangState] = useState<Lang>("en");
  const [demo, setDemo] = useState(false);
  const [tick, setTick] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const userRef = useRef<string | null>(null);
  /** Guards against bootstrap and the auth listener hydrating the same user twice. */
  const hydratingRef = useRef<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const [r, o] = await Promise.all([db.fetchReports(supabase), db.fetchOutbox(supabase)]);
      setReports(r);
      setOutbox(o);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your ledger.");
    }
  }, [supabase]);

  /**
   * Everything required to put a signed-in citizen in front of a working
   * ledger: profile, first-run seed, then load.
   *
   * This lives in ONE function because there are two ways a session arrives —
   * `getUser()` on mount, and the auth listener firing later — and an earlier
   * version only seeded on the first of those. A password login resolved
   * through `getUser()` and seeded fine; an OAuth login came back through the
   * listener and got `refetch()` alone, so a brand-new Google account landed on
   * a permanently empty map. Both paths now call this.
   */
  const hydrateForUser = useCallback(
    async (u: User) => {
      // Both callers can fire for the same session within a few ms. Without
      // this guard they race through seedIfEmpty's "is it empty?" check
      // together, both decide yes, and the second insert dies on the composite
      // primary key — surfacing a duplicate-key error for what is actually the
      // success path.
      if (hydratingRef.current === u.id) return;
      hydratingRef.current = u.id;

      setUser(u);
      userRef.current = u.id;

      const { data: profile } = await supabase
        .from("profiles")
        .select("display_name, lang, avatar_url")
        .eq("id", u.id)
        .maybeSingle();

      if (profile) {
        setDisplayName(profile.display_name ?? "");
        setAvatarUrl(profile.avatar_url ?? null);
        setLangState((profile.lang as Lang) ?? "en");
      }

      try {
        await db.seedIfEmpty(supabase, u.id);
      } catch (e) {
        // Deliberately surfaced, not swallowed. A silent failure here is
        // indistinguishable from "the app is broken" — an empty map with no
        // explanation is exactly how this bug hid.
        setError(
          e instanceof Error
            ? `Could not set up your ledger: ${e.message}`
            : "Could not set up your ledger."
        );
      }

      await refetch();
    },
    [supabase, refetch]
  );

  // --- bootstrap: session -> seed-if-empty -> load ---------------------------
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const {
        data: { user: u },
      } = await supabase.auth.getUser();

      if (cancelled) return;

      // No session yet is not necessarily "logged out" — right after an OAuth
      // redirect the client may not have hydrated cookies. The auth listener
      // picks that case up.
      if (u) await hydrateForUser(u);
      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [supabase, hydrateForUser]);

  /**
   * Live session handling.
   *
   * Without this, signing out in one tab leaves every other tab showing a
   * populated ledger it can no longer write to — the UI looks fine and every
   * action silently fails. A hard navigation on SIGNED_OUT also clears the
   * in-memory reports, so one citizen's data never lingers on screen while the
   * next person signs in on the same device.
   */
  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" || !session) {
        setReports([]);
        setOutbox([]);
        userRef.current = null;
        hydratingRef.current = null;
        setUser(null);
        window.location.href = "/login";
        return;
      }

      // A session arrived for someone we're not already showing — either a
      // fresh OAuth login, or a different account on this tab. Drop the old
      // ledger, then hydrate fully (profile + seed + load), NOT just refetch.
      if (session.user.id !== userRef.current) {
        setReports([]);
        setOutbox([]);
        void hydrateForUser(session.user).finally(() => setLoading(false));
      }
    });

    return () => subscription.unsubscribe();
  }, [supabase, hydrateForUser]);

  /**
   * Countdown ticks and the local SLA sweep share one timer.
   *
   * The sweep runs in the interval callback rather than in an effect keyed on
   * `tick` — an effect body that calls setState on every tick cascades a second
   * render each time, four times a second, for the life of the session.
   */
  useEffect(() => {
    const id = setInterval(() => {
      setTick((n) => n + 1);

      const t = now();
      setReports((prev) => {
        let changed = false;
        const next = prev.map((r) => {
          const breachable: ReportStatus[] = ["filed", "acknowledged", "transferred"];
          if (breachable.includes(r.status) && t > r.slaDeadline) {
            changed = true;
            return {
              ...r,
              status: "past_sla" as ReportStatus,
              timeline: [
                ...r.timeline,
                {
                  at: t,
                  kind: "past_sla",
                  detail: "SLA breached — authority missed its own published deadline",
                },
              ],
            };
          }
          if (r.status === "past_sla" && t > r.slaDeadline + 6 * 3_600_000) {
            changed = true;
            return {
              ...r,
              status: "escalated" as ReportStatus,
              escalationPostId: `post_${r.id}`,
              timeline: [
                ...r.timeline,
                { at: t, kind: "escalated", detail: "Published to the public ledger" },
              ],
            };
          }
          return r;
        });
        return changed ? next : prev;
      });
    }, 250);

    return () => clearInterval(id);
  }, []);

  /** Durable sweep. Fast under the demo clock, lazy under real time. */
  useEffect(() => {
    if (!user) return;
    const period = demo ? 2_000 : 60_000;
    const t = setInterval(() => {
      void db.sweep(supabase, now()).catch(() => {});
    }, period);
    return () => clearInterval(t);
  }, [supabase, user, demo]);

  const pushTrace = useCallback((line: TraceLine) => {
    setTrace((prev) => [...prev.slice(-60), line]);
  }, []);

  const clearTrace = useCallback(() => setTrace([]), []);

  const setLang = useCallback(
    (l: Lang) => {
      setLangState(l);
      if (userRef.current) {
        void supabase.from("profiles").update({ lang: l }).eq("id", userRef.current);
      }
    },
    [supabase]
  );

  const toggleDemo = useCallback(() => {
    const next = !isDemoMode();
    setDemoMode(next);
    setDemo(next);
    pushTrace({
      agent: "SLA",
      status: "warn",
      text: next
        ? "Demo clock engaged — 1 second = 1 hour. Deadlines will arrive live."
        : "Demo clock disengaged — real time resumed.",
    });
  }, [pushTrace]);

  /** Mint an id from the Postgres sequence rather than a client counter. */
  const mintId = useCallback(() => db.mintReportId(supabase), [supabase]);

  const addReport = useCallback(
    async (r: Report) => {
      setReports((prev) => [r, ...prev]);
      if (!userRef.current) return;
      try {
        await db.insertReport(supabase, r, userRef.current);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not save that report.");
        await refetch();
      }
    },
    [supabase, refetch]
  );

  const updateReport = useCallback(
    (id: string, patch: Partial<Report>) => {
      setReports((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
      if (!userRef.current) return;
      void db.updateReport(supabase, id, userRef.current, patch).catch(() => refetch());
    },
    [supabase, refetch]
  );

  const pushOutbox = useCallback(
    (items: OutboxItem[]) => {
      setOutbox((prev) => [...items, ...prev].slice(0, 60));
      if (!userRef.current) return;
      void db.insertOutbox(supabase, items, userRef.current).catch(() => {});
    },
    [supabase]
  );

  const support = useCallback(
    (id: string) => {
      const at = now();
      const target = reports.find((r) => r.id === id);
      const uid = userRef.current;
      if (!target || !uid) return;

      // The report's OWNER, which is not necessarily you — the map is
      // community-wide and backing someone else's report is the point.
      const ownerId = target.ownerId ?? uid;

      const event: TimelineEvent = {
        at,
        kind: "supported",
        detail: "Another resident added their voice",
      };

      setReports((prev) =>
        prev.map((r) =>
          r.id === id
            ? { ...r, supporters: r.supporters + 1, timeline: [...r.timeline, event] }
            : r
        )
      );

      void (async () => {
        try {
          await db.addSupport(supabase, id, ownerId, uid, at);

          // Only the owner may append to a report's timeline, so skip it when
          // backing someone else's. The supporter count is the durable record;
          // RLS is the reason this is a skip and not a failure.
          if (ownerId === uid) {
            await db.appendTimeline(supabase, id, uid, [event]);
          }

          // The counter is trigger-maintained, so read it back rather than
          // trusting the optimistic +1.
          const { data } = await supabase
            .from("reports")
            .select("supporters")
            .eq("id", id)
            .eq("user_id", ownerId)
            .maybeSingle();
          if (data) {
            setReports((prev) =>
              prev.map((r) => (r.id === id ? { ...r, supporters: data.supporters } : r))
            );
          }
        } catch {
          void refetch();
        }
      })();
    },
    [reports, supabase, refetch]
  );

  /**
   * The ONLY path to `verified_fixed`. There is deliberately no automatic
   * transition into this state anywhere in the codebase — not in the client,
   * not in `civic_sweep()`.
   */
  const confirmFixed = useCallback(
    async (id: string, afterPhotoUrl?: string) => {
      const at = now();
      const event: TimelineEvent = {
        at,
        kind: "verified_fixed",
        detail: "Citizen confirmed the repair with an after-photo. Closed.",
      };

      let storedUrl = afterPhotoUrl;
      if (afterPhotoUrl?.startsWith("data:") && userRef.current) {
        storedUrl = await db.uploadPhoto(
          supabase,
          userRef.current,
          id,
          afterPhotoUrl,
          "after"
        );
      }

      setReports((prev) =>
        prev.map((r) =>
          r.id === id
            ? {
                ...r,
                status: "verified_fixed" as ReportStatus,
                afterPhotoUrl: storedUrl ?? r.afterPhotoUrl,
                timeline: [...r.timeline, event],
              }
            : r
        )
      );

      if (!userRef.current) return;
      try {
        await db.updateReport(supabase, id, userRef.current, {
          status: "verified_fixed",
          afterPhotoUrl: storedUrl,
        });
        await db.appendTimeline(supabase, id, userRef.current, [event]);
      } catch {
        void refetch();
      }
    },
    [supabase, refetch]
  );

  /** Feed an inbound reply through the correspondence handler. */
  const receiveReply = useCallback(
    (reportId: string, reply: InboundReply) => {
      const target = reports.find((r) => r.id === reportId);
      if (!target) return;

      const classified = classifyReply(reply, target);

      pushTrace({
        agent: "AUTHORITY",
        status: classified.kind === "claims_done" ? "warn" : "info",
        text: `Reply classified: ${classified.kind.replace(/_/g, " ")}`,
      });
      pushTrace({
        agent: "SLA",
        status: classified.resetsClock ? "warn" : "ok",
        text: classified.resetsClock
          ? "Clock reset"
          : "Clock NOT reset — a transfer or status update is not a resolution",
      });
      if (classified.kind === "claims_done") {
        pushTrace({
          agent: "GUARD",
          status: "warn",
          text: "Marked as claimed-only. Citizen verification required before closure.",
        });
      }

      const updated = applyReply(target, classified);
      setReports((prev) => prev.map((r) => (r.id === reportId ? updated : r)));

      if (!userRef.current) return;
      const uid = userRef.current;
      const at = now();

      void (async () => {
        try {
          await db.updateReport(supabase, reportId, uid, {
            status: updated.status,
            slaDeadline: updated.slaDeadline,
            filedTo: updated.filedTo,
            timeline: updated.timeline,
          });

          // Persist the inbound body. Previously only the resulting status
          // change survived, which left a report saying "transferred" with no
          // evidence of who said so or why.
          await db.insertInboundReply(supabase, uid, reportId, {
            at,
            from: reply.from,
            subject: reply.subject,
            body: reply.body,
            kind: classified.kind,
          });

          // Compose the auto-response HERE rather than at the call site. The
          // rich text lives on `classified.autoResponse` and was previously
          // computed and thrown away — the caller sent the literal string
          // "Auto-response sent" as the email body instead.
          //
          // `acknowledged` deliberately carries no autoResponse: replying to an
          // acknowledgement is noise, so we send nothing rather than an empty
          // mail.
          if (classified.autoResponse) {
            const item = composeReply(updated, reply.from, classified.autoResponse);
            setOutbox((prev) => [item, ...prev].slice(0, 60));
            await db.insertOutbox(supabase, [item], uid);
          }
        } catch {
          void refetch();
        }
      })();

      return classified;
    },
    [reports, pushTrace, supabase, refetch]
  );

  /** Wipe this account's ledger and re-seed it. Scoped by RLS to the caller. */
  const resetAll = useCallback(async () => {
    if (!userRef.current) return;
    setLoading(true);
    try {
      await supabase.from("reports").delete().eq("user_id", userRef.current);
      await supabase.from("outbox_items").delete().eq("user_id", userRef.current);
      await db.seedIfEmpty(supabase, userRef.current);
      setTrace([]);
      await refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reset failed.");
    } finally {
      setLoading(false);
    }
  }, [supabase, refetch]);

  /**
   * Reports this citizen filed. The map is community-wide, but "My Reports",
   * the header counters and the honest fix rate must all describe YOUR ledger —
   * mixing in other people's reports would make the headline number a
   * city-wide average dressed up as personal accountability.
   */
  const myReports = useMemo(
    () => (user ? reports.filter((r) => !r.ownerId || r.ownerId === user.id) : reports),
    [reports, user]
  );

  const stats = useMemo(() => {
    // Deliberately MY reports, not the community feed: the headline fix rate is
    // a claim about this citizen's ledger. Averaging in everyone else's would
    // turn a personal accountability number into a city-wide statistic wearing
    // its clothes.
    const reports = myReports;
    const open = reports.filter((r) => isOpen(r.status)).length;
    const breached = reports.filter((r) => isBreached(r.status)).length;
    const verified = reports.filter((r) => r.status === "verified_fixed").length;
    const claimed = reports.filter((r) => r.status === "claims_done").length;

    // The honest fix rate: citizen-VERIFIED closures only. Authority claims
    // explicitly do not count — that difference is the whole product.
    const fixRate = reports.length ? Math.round((verified / reports.length) * 100) : 0;
    const claimedRate = reports.length
      ? Math.round(((verified + claimed) / reports.length) * 100)
      : 0;

    return { open, breached, verified, claimed, fixRate, claimedRate, total: reports.length };
  }, [myReports]);

  const recentlyFixed = useMemo(
    () =>
      myReports
        .filter((r) => r.status === "verified_fixed")
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 10),
    [myReports]
  );

  return {
    user,
    displayName,
    avatarUrl,
    loading,
    error,
    dismissError: useCallback(() => setError(null), []),
    reports,
    myReports,
    outbox,
    stats,
    recentlyFixed,
    trace,
    demo,
    lang,
    setLang,
    toggleDemo,
    pushTrace,
    clearTrace,
    mintId,
    addReport,
    updateReport,
    pushOutbox,
    support,
    confirmFixed,
    receiveReply,
    resetAll,
    refetch,
    uploadPhoto: useCallback(
      (reportId: string, dataUrl: string) =>
        userRef.current
          ? db.uploadPhoto(supabase, userRef.current, reportId, dataUrl)
          : Promise.resolve(dataUrl),
      [supabase]
    ),
    tick,
  };
}
