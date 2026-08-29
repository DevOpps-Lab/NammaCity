import { NextResponse } from "next/server";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { authorisedScheduler } from "@/lib/api-auth";
import { now } from "@/lib/demoClock";

/**
 * ESCALATION LADDER — which reports are due the next rung.
 *
 * Escalation today means one public post, and then nothing, ever. The report
 * sits at `escalated` while its deadline recedes, which is a weaker threat than
 * the product's argument needs: a department that ignores a tweet has ignored
 * the entire consequence.
 *
 * The next rung is an RTI status request. That matters because it is the only
 * clock in this product with legal force behind it — the RTI Act 2005 gives a
 * statutory 30-day deadline and puts it on a named Public Information Officer,
 * where a citizen charter deadline binds nobody. `composeRti()` has been written
 * and RTI-Act-grounded since early on, and has only ever run from a manual
 * button.
 *
 * This endpoint answers "what is due?" and nothing else. Acting is a separate
 * call, so an orchestrator (n8n) can see the queue, decide, batch and retry —
 * which is the whole reason this is two endpoints rather than one sweep.
 */

export const runtime = "nodejs";

/** How long a report sits at `escalated` before the RTI rung comes due. */
const RTI_AFTER_DAYS = 3;

export interface EscalationCandidate {
  reportId: string;
  owner: string;
  place: string;
  category: string;
  rung: "rti";
  daysOpen: number;
  daysSinceEscalated: number;
}

export async function GET(req: Request) {
  if (!(await authorisedScheduler(req))) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }
  if (!adminConfigured()) {
    return NextResponse.json({ configured: false, candidates: [] });
  }

  const admin = createAdminClient();
  const at = now();

  // Seeded demo rows must never generate real correspondence.
  const { data: reports, error } = await admin
    .from("reports")
    .select("id, user_id, place, category, created_at")
    .eq("status", "escalated")
    .eq("is_seed", false);
  if (error) {
    console.error("[escalation] could not read the ledger", error.message);
    return NextResponse.json({ error: "query failed" }, { status: 502 });
  }
  if (!reports?.length) return NextResponse.json({ configured: true, candidates: [] });

  const ids = reports.map((r) => r.id as string);

  // Already escalated to RTI? `kind` is constrained to
  // ('complaint','reply','post','rti') in 0001_init.sql, so this is the whole
  // test — and it is what makes acting idempotent without a separate flag.
  const { data: sent } = await admin
    .from("outbox_items")
    .select("user_id, report_id")
    .eq("kind", "rti")
    .in("report_id", ids);
  const alreadySent = new Set((sent ?? []).map((o) => `${o.user_id}:${o.report_id}`));

  // When did each report actually escalate? The timeline is the record; the SLA
  // deadline is not, because a transfer can move it after the fact.
  const { data: events } = await admin
    .from("timeline_events")
    .select("user_id, report_id, at")
    .eq("kind", "escalated")
    .in("report_id", ids);

  const escalatedAt = new Map<string, number>();
  for (const e of events ?? []) {
    const key = `${e.user_id}:${e.report_id}`;
    // Earliest escalation, so a re-escalation cannot reset the ladder.
    const prev = escalatedAt.get(key);
    if (prev === undefined || Number(e.at) < prev) escalatedAt.set(key, Number(e.at));
  }

  const candidates: EscalationCandidate[] = [];
  for (const r of reports) {
    const key = `${r.user_id}:${r.id}`;
    if (alreadySent.has(key)) continue;

    const since = escalatedAt.get(key);
    // No escalation event means we cannot date the rung. Skip rather than guess
    // — an RTI filed on a wrong date is worse than one filed late.
    if (since === undefined) continue;

    const daysSinceEscalated = Math.floor((at - since) / 86_400_000);
    if (daysSinceEscalated < RTI_AFTER_DAYS) continue;

    candidates.push({
      reportId: r.id as string,
      owner: r.user_id as string,
      place: (r.place as string) ?? "",
      category: r.category as string,
      rung: "rti",
      daysOpen: Math.floor((at - Number(r.created_at)) / 86_400_000),
      daysSinceEscalated,
    });
  }

  return NextResponse.json({ configured: true, candidates });
}
