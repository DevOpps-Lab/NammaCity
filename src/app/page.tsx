"use client";

import { useCallback, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useCivicStore } from "@/lib/store";
import TopBar from "@/components/TopBar";
import TabBar, { type TabKey } from "@/components/TabBar";
import ReportTab, { type ConfirmedReport } from "@/components/ReportTab";
import ReportList from "@/components/ReportList";
import ReportSheet from "@/components/ReportSheet";
import AgentTrace from "@/components/AgentTrace";
import VerifyPanel from "@/components/VerifyPanel";
import EscalationPanel from "@/components/EscalationPanel";
import OutboxPanel from "@/components/OutboxPanel";
import DuplicatePrompt from "@/components/DuplicatePrompt";
import type { Report } from "@/lib/types";
import { findDuplicates, type DuplicateCandidate } from "@/lib/dedup";
import { composeRti, composePostItem } from "@/lib/outbox";
import type { AuthorityRecord } from "@/lib/authorities";
import { DEMO_REPLIES } from "@/lib/correspondence";
import { fileReport } from "@/lib/pipeline";
import { t } from "@/lib/i18n";

const CivicMap = dynamic(() => import("@/components/CivicMap"), { ssr: false });

export default function Home() {
  const store = useCivicStore();

  const [tab, setTab] = useState<TabKey>("report");
  const [selected, setSelected] = useState<Report | null>(null);
  const [verifying, setVerifying] = useState<Report | null>(null);
  const [escalating, setEscalating] = useState<Report | null>(null);
  const [outboxOpen, setOutboxOpen] = useState(false);
  const [dupes, setDupes] = useState<DuplicateCandidate[] | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmedReport | null>(null);
  const [traceOpen, setTraceOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const traceLine = useCallback(
    (text: string, status?: "ok" | "warn" | "info") =>
      store.pushTrace({ agent: "GUARD", text, status }),
    [store]
  );

  /**
   * Message counts per report, for the correspondence hint in the list.
   * Derived, not stored — it is a pure function of the outbox.
   */
  const threadCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const o of store.outbox) {
      if (o.reportId) counts[o.reportId] = (counts[o.reportId] ?? 0) + 1;
    }
    return counts;
  }, [store.outbox]);

  /** Everything the citizen confirmed is already resolved — just file it. */
  const commit = useCallback(
    async (c: ConfirmedReport) => {
      setBusy(true);
      store.clearTrace();
      setTraceOpen(true);

      const report = await fileReport(
        {
          pushTrace: store.pushTrace,
          mintId: store.mintId,
          uploadPhoto: store.uploadPhoto,
          addReport: store.addReport,
          pushOutbox: store.pushOutbox,
        },
        {
          image: c.image,
          detection: c.detection,
          category: c.category,
          categorySource: c.categorySource,
          categoryConfidence: c.categoryConfidence,
          fix: c.fix,
          routing: c.resolved.routing,
          authorities: c.resolved.authorities,
          resolveMs: c.resolved.ms,
        }
      );

      setBusy(false);
      // Land on the ledger with the new report open, rather than on a map pin —
      // what the citizen wants next is to watch it, not to look at it.
      setTab("reports");
      setSelected(report);
    },
    [store]
  );

  /** Dedup runs before filing: joining an existing report beats a duplicate ticket. */
  const onConfirm = useCallback(
    async (c: ConfirmedReport) => {
      const found = findDuplicates(
        { lat: c.fix.lat, lng: c.fix.lng, category: c.category, aHash: c.image.aHash },
        store.myReports
      );
      if (found.length) {
        store.pushTrace({
          agent: "TRIAGE",
          status: "warn",
          text: `${found.length} possible duplicate(s) nearby — asking before filing`,
        });
        setPendingConfirm(c);
        setDupes(found);
        return;
      }
      await commit(c);
    },
    [store, commit]
  );

  const { stats, lang, user } = store;
  const live = selected
    ? (store.reports.find((r) => r.id === selected.id) ?? selected)
    : null;
  /** Only the citizen who filed a report may verify, escalate or close it. */
  const mine = live ? !live.ownerId || live.ownerId === user?.id : false;

  if (store.loading) return <LedgerSkeleton />;

  return (
    <>
      <TopBar
        stats={stats}
        lang={lang}
        demo={store.demo}
        outboxCount={store.outbox.length}
        displayName={store.displayName}
        email={store.user?.email ?? ""}
        avatarUrl={store.avatarUrl}
        onToggleLang={() => store.setLang(lang === "en" ? "ta" : "en")}
        onToggleDemo={store.toggleDemo}
        onOpenOutbox={() => setOutboxOpen(true)}
        onToggleTrace={() => setTraceOpen((v) => !v)}
        onReset={() => void store.resetAll()}
      />

      {store.error && (
        <div
          role="alert"
          className="fade-in flex shrink-0 items-center gap-3 border-b border-[var(--danger)]/40 bg-[var(--danger)]/10 px-4 py-2"
        >
          <span className="text-[12px] text-[var(--danger)]">{store.error}</span>
          <button
            onClick={store.dismissError}
            className="ml-auto shrink-0 text-[11px] font-medium text-[var(--text-dim)] hover:text-[var(--text)]"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Content row. Every absolute overlay below is scoped HERE, which is what
          keeps the in-flow tab bar clear of them without any z-index juggling. */}
      <div className="relative flex min-h-0 flex-1">
        <TabBar active={tab} onChange={setTab} badge={stats.claimed} />

        <div className="relative min-w-0 flex-1">
          {tab === "report" && (
            <ReportTab
              lang={lang}
              displayName={store.displayName}
              onConfirm={onConfirm}
              busy={busy}
            />
          )}

          {tab === "reports" && (
            <ReportList
              reports={store.myReports}
              threadCounts={threadCounts}
              onSelect={(r) => setSelected(r)}
            />
          )}

          {/* Kept MOUNTED so MapLibre isn't rebuilt on every tab switch. */}
          <div
            className={
              tab === "map"
                ? "absolute inset-0"
                : "pointer-events-none absolute inset-0 opacity-0"
            }
          >
            <CivicMap
              reports={store.reports}
              selectedId={live?.id}
              visible={tab === "map"}
              onSelect={(r) => setSelected(r)}
            />
            {tab === "map" && (
              <>
                <div className="pointer-events-none absolute inset-x-0 top-0 z-[var(--z-overlay)] px-3 pt-3">
                  <p className="mx-auto w-fit rounded-full border border-[var(--border)] bg-[var(--surface)]/92 px-3 py-1 text-[10px] text-[var(--text-dim)] backdrop-blur">
                    {t(lang, "reportsNotProblems")}
                  </p>
                </div>

                <div className="pointer-events-none absolute bottom-3 left-3 z-[var(--z-overlay)] hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]/95 p-2.5 backdrop-blur md:block">
                  <LegendRow color="var(--danger)" label="Past deadline" />
                  <LegendRow color="#8a9c8f" label="Claimed fixed — unverified" hollow />
                  <LegendRow color="var(--success)" label="Citizen-verified" />
                  <p className="mt-1.5 max-w-[20ch] border-t border-[var(--border)] pt-1.5 text-[9px] leading-relaxed text-[var(--text-faint)]">
                    Community-wide. You can open anyone&apos;s report; only the
                    citizen who filed one can close it.
                  </p>
                </div>
              </>
            )}
          </div>
        </div>

        <aside className="hidden w-[320px] shrink-0 lg:block xl:w-[360px]">
          <AgentTrace lines={store.trace} onClear={store.clearTrace} />
        </aside>

        {traceOpen && (
          <>
            <button
              aria-label="Close agent trace"
              onClick={() => setTraceOpen(false)}
              className="fade-in absolute inset-0 z-[var(--z-sheet)] bg-[var(--scrim)] backdrop-blur-sm lg:hidden"
            />
            <aside className="absolute inset-y-0 right-0 z-[var(--z-sheet)] w-[min(340px,88vw)] shadow-2xl lg:hidden">
              <AgentTrace
                lines={store.trace}
                onClear={store.clearTrace}
                onClose={() => setTraceOpen(false)}
              />
            </aside>
          </>
        )}

        {dupes && pendingConfirm && (
          <DuplicatePrompt
            candidates={dupes}
            onJoin={(id) => {
              store.support(id);
              store.pushTrace({
                agent: "FILING",
                status: "ok",
                text: `Voice added to ${id} — no duplicate ticket created`,
              });
              setDupes(null);
              setPendingConfirm(null);
              setTab("reports");
              setSelected(store.reports.find((r) => r.id === id) ?? null);
            }}
            onFileAnyway={() => {
              const c = pendingConfirm;
              setDupes(null);
              setPendingConfirm(null);
              void commit(c);
            }}
            onCancel={() => {
              setDupes(null);
              setPendingConfirm(null);
              store.clearTrace();
            }}
          />
        )}

        {live && (
          <ReportSheet
            report={live}
            lang={lang}
            canAct={mine}
            replies={DEMO_REPLIES}
            onClose={() => setSelected(null)}
            onSupport={store.support}
            onRequestVerify={(r) => setVerifying(r)}
            onRequestEscalate={(r) => setEscalating(r)}
            onReply={(id, reply) => {
              store.receiveReply(id, reply);
              setTraceOpen(true);
            }}
            onFileRti={(r) => {
              const auth = r.routing.authorities?.[0] as AuthorityRecord | undefined;
              if (!auth) return;
              store.pushOutbox([composeRti(r, auth)]);
              store.pushTrace({
                agent: "FILING",
                status: "ok",
                text: `RTI status request composed for ${r.id} (RTI Act s.4(1)(b))`,
              });
              setOutboxOpen(true);
            }}
          />
        )}

        {verifying && (
          <VerifyPanel
            report={verifying}
            onClose={() => setVerifying(null)}
            onConfirmFixed={store.confirmFixed}
            onTrace={traceLine}
          />
        )}

        {escalating && (
          <EscalationPanel
            report={escalating}
            onClose={() => setEscalating(null)}
            onPublish={(id, text) => {
              const r = store.reports.find((x) => x.id === id);
              store.updateReport(id, { status: "escalated", escalationPostId: `post_${id}` });
              if (r) store.pushOutbox([composePostItem(r, text)]);
            }}
            onTrace={traceLine}
          />
        )}

        {outboxOpen && (
          <OutboxPanel items={store.outbox} onClose={() => setOutboxOpen(false)} />
        )}
      </div>
    </>
  );
}

function LedgerSkeleton() {
  return (
    <div className="flex flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-4">
        <span className="shimmer h-8 w-8 shrink-0 rounded-lg" />
        <span className="shimmer h-8 w-24 rounded-lg" />
        <span className="shimmer hidden h-8 w-16 rounded-lg sm:block" />
        <span className="shimmer ml-auto h-9 w-9 rounded-lg" />
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center bg-[var(--bg)]">
        <div className="flex flex-col items-center gap-3">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--surface-3)] border-t-[var(--accent)]" />
          <p className="text-[12px] text-[var(--text-dim)]">Loading your ledger…</p>
        </div>
      </div>
    </div>
  );
}

function LegendRow({
  color,
  label,
  hollow,
}: {
  color: string;
  label: string;
  hollow?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{
          background: hollow ? "transparent" : color,
          border: `2px ${hollow ? "dashed" : "solid"} ${color}`,
        }}
      />
      <span className="whitespace-nowrap text-[10px] text-[var(--text-dim)]">{label}</span>
    </div>
  );
}
