import type { SupabaseClient } from "@supabase/supabase-js";
import type { Report, ReportStatus, TimelineEvent } from "./types";
import type { OutboxItem } from "./outbox";
import { buildSeedReports, buildSeedOutbox, buildSeedInbound } from "./seed";

/**
 * DATA ACCESS
 *
 * Postgres is the source of truth. Every function here is owner-scoped by RLS
 * rather than by a `where user_id = ...` we remember to write, so a bug in this
 * file cannot leak another citizen's ledger.
 *
 * Report lifecycle times are epoch-ms `bigint` columns because the demo clock
 * redefines "now". Postgres `bigint` arrives over PostgREST as a JS number,
 * which is exact well past year 275760 for ms values, so no BigInt handling.
 */

type DB = SupabaseClient;

interface ReportRow {
  id: string;
  user_id: string;
  lat: number;
  lng: number;
  place: string;
  category: Report["category"];
  category_source: Report["categorySource"];
  category_confidence: number;
  severity: Report["severity"];
  detection_confidence: number;
  photo_url: string;
  after_photo_url: string | null;
  a_hash: string | null;
  status: ReportStatus;
  routing: Report["routing"];
  created_at: number;
  sla_deadline: number;
  filed_to: string[];
  supporters: number;
  escalation_post_id: string | null;
  timeline_events?: { at: number; kind: string; detail: string }[];
}

function rowToReport(row: ReportRow): Report {
  const timeline: TimelineEvent[] = (row.timeline_events ?? [])
    .map((e) => ({ at: e.at, kind: e.kind, detail: e.detail }))
    .sort((a, b) => a.at - b.at);

  return {
    id: row.id,
    ownerId: row.user_id,
    lat: row.lat,
    lng: row.lng,
    place: row.place,
    category: row.category,
    categorySource: row.category_source ?? "user",
    categoryConfidence: row.category_confidence ?? 0,
    severity: row.severity,
    detectionConfidence: row.detection_confidence,
    photoUrl: row.photo_url,
    afterPhotoUrl: row.after_photo_url ?? undefined,
    aHash: row.a_hash ?? undefined,
    status: row.status,
    routing: row.routing,
    createdAt: row.created_at,
    slaDeadline: row.sla_deadline,
    filedTo: row.filed_to ?? [],
    supporters: row.supporters,
    escalationPostId: row.escalation_post_id ?? undefined,
    timeline,
  };
}

function reportToRow(r: Report, userId: string) {
  return {
    id: r.id,
    user_id: userId,
    lat: r.lat,
    lng: r.lng,
    place: r.place,
    category: r.category,
    category_source: r.categorySource ?? "user",
    category_confidence: r.categoryConfidence ?? 0,
    severity: r.severity,
    detection_confidence: r.detectionConfidence,
    photo_url: r.photoUrl,
    after_photo_url: r.afterPhotoUrl ?? null,
    a_hash: r.aHash ?? null,
    status: r.status,
    routing: r.routing,
    created_at: r.createdAt,
    sla_deadline: r.slaDeadline,
    filed_to: r.filedTo,
    supporters: r.supporters,
    escalation_post_id: r.escalationPostId ?? null,
  };
}

/** Column list is explicit so an added column can't silently bloat every fetch. */
const REPORT_COLUMNS = `
  id, user_id, lat, lng, place, category, category_source, category_confidence,
  severity, detection_confidence,
  photo_url, after_photo_url, a_hash, status, routing, created_at,
  sla_deadline, filed_to, supporters, escalation_post_id,
  timeline_events ( at, kind, detail )
`;

export async function fetchReports(db: DB): Promise<Report[]> {
  const { data, error } = await db
    .from("reports")
    .select(REPORT_COLUMNS)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data as unknown as ReportRow[]).map(rowToReport);
}

/**
 * One report by (owner, id). Explicitly scoped by user_id — unlike the
 * RLS-scoped fetches above, this is called from the inbound webhook through the
 * service-role client, which bypasses RLS, so the owner filter is load-bearing:
 * report ids are per-account (PK is (user_id, id)) and seed ids repeat.
 */
export async function fetchReportByOwner(
  db: DB,
  userId: string,
  reportId: string
): Promise<Report | null> {
  const { data, error } = await db
    .from("reports")
    .select(REPORT_COLUMNS)
    .eq("user_id", userId)
    .eq("id", reportId)
    .maybeSingle();

  if (error) throw error;
  return data ? rowToReport(data as unknown as ReportRow) : null;
}

/**
 * One report by its public token, for the unauthenticated /track page.
 *
 * The token exists because the PK is (user_id, id) and ids repeat across
 * accounts, so a bare id addresses nothing — and because ids come from a
 * sequence, which would let anyone handed one link walk the rest. Called
 * through the service-role client: every RLS policy is owner-scoped, so the
 * anon key reads zero rows, and a citizen who filed over WhatsApp has no
 * session at all. The token IS the authorisation here, which is why it is a
 * uuid and not something guessable.
 */
export async function fetchReportByToken(db: DB, token: string): Promise<Report | null> {
  const { data, error } = await db
    .from("reports")
    .select(`${REPORT_COLUMNS}, source`)
    .eq("public_token", token)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  const source = (data as { source?: "app" | "whatsapp" }).source ?? "app";
  return { ...rowToReport(data as unknown as ReportRow), source };
}

export async function fetchOutbox(db: DB): Promise<OutboxItem[]> {
  const { data, error } = await db
    .from("outbox_items")
    .select("*")
    .order("at", { ascending: false })
    .limit(60);

  if (error) throw error;

  return (data ?? []).map((o) => ({
    id: o.id,
    kind: o.kind,
    at: o.at,
    intendedTo: o.intended_to,
    actuallyTo: o.actually_to,
    subject: o.subject,
    body: o.body,
    reportId: o.report_id,
    recipientVerified: o.recipient_verified,
    delivered: o.delivered,
  }));
}

/** Report ids come from a Postgres sequence — two browsers can't mint the same one. */
export async function mintReportId(db: DB): Promise<string> {
  const { data, error } = await db.rpc("next_report_id");
  if (error) throw error;
  return data as string;
}

export async function insertReport(db: DB, report: Report, userId: string) {
  const { error } = await db.from("reports").insert(reportToRow(report, userId));
  if (error) throw error;

  if (report.timeline.length) {
    await appendTimeline(db, report.id, userId, report.timeline);
  }
}

export async function appendTimeline(
  db: DB,
  reportId: string,
  userId: string,
  events: TimelineEvent[]
) {
  if (!events.length) return;
  const { error } = await db.from("timeline_events").insert(
    events.map((e) => ({
      report_id: reportId,
      user_id: userId,
      at: e.at,
      kind: e.kind,
      detail: e.detail,
    }))
  );
  if (error) throw error;
}

/**
 * Patch a report. Timeline entries are appended as rows rather than overwriting
 * a JSON blob, so two tabs updating the same report can't clobber each other's
 * history.
 */
export async function updateReport(
  db: DB,
  id: string,
  userId: string,
  patch: Partial<Report>
) {
  const row: Record<string, unknown> = {};
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.place !== undefined) row.place = patch.place;
  if (patch.afterPhotoUrl !== undefined) row.after_photo_url = patch.afterPhotoUrl;
  if (patch.photoUrl !== undefined) row.photo_url = patch.photoUrl;
  if (patch.slaDeadline !== undefined) row.sla_deadline = patch.slaDeadline;
  if (patch.filedTo !== undefined) row.filed_to = patch.filedTo;
  if (patch.routing !== undefined) row.routing = patch.routing;
  if (patch.escalationPostId !== undefined) {
    row.escalation_post_id = patch.escalationPostId;
  }

  if (Object.keys(row).length) {
    // user_id is scoped explicitly, not just left to RLS: this is also called
    // from the inbound webhook via the service-role client, which bypasses RLS.
    const { error } = await db
      .from("reports")
      .update(row)
      .eq("user_id", userId)
      .eq("id", id);
    if (error) throw error;
  }

  if (patch.timeline?.length) {
    // Only the events not already persisted.
    const { data } = await db
      .from("timeline_events")
      .select("at, kind")
      .eq("user_id", userId)
      .eq("report_id", id);

    const seen = new Set((data ?? []).map((e) => `${e.at}:${e.kind}`));
    const fresh = patch.timeline.filter((e) => !seen.has(`${e.at}:${e.kind}`));
    await appendTimeline(db, id, userId, fresh);
  }
}

/**
 * Add your voice to a report — yours or anyone's.
 *
 * Three ids are involved and conflating any two of them breaks something:
 *   ownerId     — whose report it is; half of the FK, since report ids are
 *                 per-account and CA-4520 is not unique on its own
 *   reportId    — the human-facing reference
 *   supporterId — you
 *
 * The composite PK makes tapping twice a no-op rather than an inflated count,
 * and a trigger keeps reports.supporters in sync.
 */
export async function addSupport(
  db: DB,
  reportId: string,
  ownerId: string,
  supporterId: string,
  at: number
) {
  const { error } = await db
    .from("report_supports")
    .upsert(
      { report_id: reportId, user_id: ownerId, supporter_id: supporterId, at },
      { onConflict: "user_id,report_id,supporter_id", ignoreDuplicates: true }
    );
  if (error) throw error;
}

export async function insertOutbox(db: DB, items: OutboxItem[], userId: string) {
  if (!items.length) return;
  const { error } = await db.from("outbox_items").insert(
    items.map((i) => ({
      user_id: userId,
      report_id: i.reportId,
      kind: i.kind,
      at: i.at,
      intended_to: i.intendedTo,
      actually_to: i.actuallyTo,
      subject: i.subject,
      body: i.body,
      recipient_verified: i.recipientVerified,
      delivered: i.delivered,
    }))
  );
  if (error) throw error;
}

/** A report's full correspondence thread: what we sent and what came back. */
export interface ThreadEntry {
  id: string;
  at: number;
  direction: "outbound" | "inbound";
  who: string;
  subject: string;
  body: string;
  kind: string;
  /** Outbound only: false when the intended address isn't primary-source verified. */
  recipientVerified?: boolean;
  /** Outbound only: where it actually went (always the sandbox sink). */
  actuallyTo?: string;
}

export async function insertInboundReply(
  db: DB,
  userId: string,
  reportId: string,
  reply: { at: number; from: string; subject: string; body: string; kind: string }
) {
  const { error } = await db.from("inbound_replies").insert({
    user_id: userId,
    report_id: reportId,
    at: reply.at,
    from_addr: reply.from,
    subject: reply.subject,
    body: reply.body,
    kind: reply.kind,
  });
  if (error) throw error;
}

/**
 * The merged thread for one report.
 *
 * Fetched per-report rather than sliced out of the account-wide outbox, which
 * is capped at 60 rows — a busy account would have silently truncated older
 * threads with no indication anything was missing.
 */
export async function fetchThread(db: DB, reportId: string): Promise<ThreadEntry[]> {
  const [out, inb] = await Promise.all([
    db.from("outbox_items").select("*").eq("report_id", reportId).order("at"),
    db.from("inbound_replies").select("*").eq("report_id", reportId).order("at"),
  ]);

  const entries: ThreadEntry[] = [
    ...(out.data ?? []).map((o) => ({
      id: o.id,
      at: o.at,
      direction: "outbound" as const,
      who: o.intended_to,
      subject: o.subject,
      body: o.body,
      kind: o.kind,
      recipientVerified: o.recipient_verified,
      actuallyTo: o.actually_to,
    })),
    ...(inb.data ?? []).map((r) => ({
      id: r.id,
      at: r.at,
      direction: "inbound" as const,
      who: r.from_addr,
      subject: r.subject,
      body: r.body,
      kind: r.kind,
    })),
  ];

  return entries.sort((a, b) => a.at - b.at);
}

/**
 * Server-side SLA sweep. `p_now` comes from the client because the demo clock
 * owns "now" — but the transitions themselves happen in Postgres, and
 * `verified_fixed` is unreachable from that function by construction.
 */
export async function sweep(db: DB, now: number) {
  const { error } = await db.rpc("civic_sweep", { p_now: now });
  if (error) throw error;
}

// -------------------------------------------------------------- comments (feed)

export interface Comment {
  id: string;
  reportId: string;
  author: string;
  /** Denormalised area label, so the feed can stay anonymous ("A resident · X"). */
  authorArea: string | null;
  at: number;
  body: string;
}

export async function fetchComments(db: DB, reportId: string): Promise<Comment[]> {
  const { data, error } = await db
    .from("report_comments")
    .select("id, report_id, author, author_area, at, body")
    .eq("report_id", reportId)
    .order("at");
  if (error) throw error;
  return (data ?? []).map((c) => ({
    id: c.id,
    reportId: c.report_id,
    author: c.author,
    authorArea: c.author_area,
    at: c.at,
    body: c.body,
  }));
}

/** Comment counts across every visible report, for the feed cards. */
export async function fetchCommentCounts(db: DB): Promise<Record<string, number>> {
  const { data, error } = await db.from("report_comments").select("report_id");
  if (error) throw error;
  const counts: Record<string, number> = {};
  for (const row of data ?? []) counts[row.report_id] = (counts[row.report_id] ?? 0) + 1;
  return counts;
}

export async function addComment(
  db: DB,
  input: {
    reportId: string;
    reportOwner: string;
    author: string;
    area: string | null;
    at: number;
    body: string;
  }
) {
  const { error } = await db.from("report_comments").insert({
    report_id: input.reportId,
    report_owner: input.reportOwner,
    author: input.author,
    author_area: input.area,
    at: input.at,
    body: input.body,
  });
  if (error) throw error;
}

// ----------------------------------------------------- public posts (X timeline)

export interface PublicPost {
  id: string;
  reportId: string | null;
  kind: "escalation" | "update" | "summary";
  body: string;
  source: "simulated" | "x" | "bluesky";
  tweetId: string | null;
  tweetUrl: string | null;
  at: number;
}

export async function fetchPublicPosts(db: DB, limit = 60): Promise<PublicPost[]> {
  const { data, error } = await db
    .from("public_posts")
    .select("id, report_id, kind, body, source, tweet_id, tweet_url, at")
    .order("at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((p) => ({
    id: p.id,
    reportId: p.report_id,
    kind: p.kind,
    body: p.body,
    source: p.source,
    tweetId: p.tweet_id,
    tweetUrl: p.tweet_url,
    at: p.at,
  }));
}

/**
 * Community-verified closure. Calls the SECURITY DEFINER `verify_and_close`
 * RPC, which can close a report the caller does not own — but only with a
 * verifying photo. Returns true when a report actually transitioned.
 */
export async function verifyAndClose(
  db: DB,
  input: { owner: string; reportId: string; afterUrl: string; source: string; now: number }
): Promise<boolean> {
  const { data, error } = await db.rpc("verify_and_close", {
    p_owner: input.owner,
    p_report_id: input.reportId,
    p_after_url: input.afterUrl,
    p_source: input.source,
    p_now: input.now,
  });
  if (error) throw error;
  return Boolean(data);
}

/**
 * Upload a redacted photo and return its public URL.
 *
 * The data URL arriving here has already been through the canvas redaction
 * pipeline — faces pixelated, EXIF dropped. Keyed under the user's folder to
 * satisfy the storage RLS policy.
 */
export async function uploadPhoto(
  db: DB,
  userId: string,
  reportId: string,
  dataUrl: string,
  kind: "before" | "after" = "before"
): Promise<string> {
  const blob = await (await fetch(dataUrl)).blob();
  const path = `${userId}/${reportId}-${kind}-${Date.now()}.jpg`;

  const { error } = await db.storage
    .from("report-photos")
    .upload(path, blob, { contentType: blob.type || "image/jpeg", upsert: true });

  // A storage failure must not lose the report. Fall back to the inline data
  // URL so the ledger entry still renders.
  if (error) return dataUrl;

  const { data } = db.storage.from("report-photos").getPublicUrl(path);
  return data.publicUrl;
}

/**
 * First-login seeding.
 *
 * A brand new account facing an empty map has nothing to demonstrate, so each
 * account gets its own copy of the Chennai caseload — owned by them, and
 * therefore actually actionable under the owner-scoped RLS policies.
 */
export async function seedIfEmpty(db: DB, userId: string): Promise<boolean> {
  const { count, error } = await db
    .from("reports")
    .select("id", { count: "exact", head: true });

  if (error) throw error;
  if ((count ?? 0) > 0) return false;

  const seeds = buildSeedReports(Date.now());

  const { error: insErr } = await db
    .from("reports")
    .insert(seeds.map((r) => ({ ...reportToRow(r, userId), is_seed: true })));

  // 23505 = unique violation. Two hydration paths can reach the "is it empty?"
  // check together and both decide yes — React StrictMode remounts in dev,
  // which recreates the ref guarding against exactly this. A duplicate key here
  // means a CONCURRENT SEED ALREADY WON, so it is the success path, not a
  // failure. Reporting it as one showed "Could not set up your ledger" over a
  // ledger that had been set up perfectly.
  if (insErr) {
    if (insErr.code === "23505") return false;
    throw insErr;
  }

  const events = seeds.flatMap((r) =>
    r.timeline.map((e) => ({
      report_id: r.id,
      user_id: userId,
      at: e.at,
      kind: e.kind,
      detail: e.detail,
    }))
  );
  if (events.length) await db.from("timeline_events").insert(events);

  // Correspondence. Without it every seeded report opens to an empty thread and
  // the correspondence engine — one of the more interesting things here — is
  // invisible until the citizen files something of their own.
  const { inbound, replies } = buildSeedInbound(seeds);

  const outboxRows = [...buildSeedOutbox(seeds), ...replies].map((o) => ({
    ...o,
    user_id: userId,
  }));
  if (outboxRows.length) await db.from("outbox_items").insert(outboxRows);

  const inboundRows = inbound.map((r) => ({ ...r, user_id: userId }));
  if (inboundRows.length) await db.from("inbound_replies").insert(inboundRows);

  return true;
}
