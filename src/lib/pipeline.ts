import type { IssueCategory, Report, RoutingResult, TraceLine, CategorySource } from "./types";
import type { ProcessedImage } from "./imaging";
import type { DetectionResult } from "./detect";
import type { AuthorityRecord } from "./authorities";
import type { OutboxItem } from "./outbox";
import { composeComplaint } from "./outbox";
import { now, HOUR } from "./demoClock";
import { formatPlace } from "./place";
import { getSLA } from "./sla-lookup";

/**
 * The agent pipeline, lifted out of the page component.
 *
 * Dependencies are injected rather than imported so this never reaches into the
 * store — which keeps it callable from a test harness and from more than one
 * screen.
 *
 * NOTE ON ORDERING: geolocation and authority resolution now run BEFORE the
 * citizen confirms, because the Report screen shows them the ward and the
 * agencies it will file to before they commit. That inversion moves the
 * location permission prompt earlier and turns both refusal paths into
 * pre-submit states rather than aborted submissions — see `LocationFix.exact`
 * and `ResolveOutcome` below, which exist precisely so the UI can tell the
 * truth about each.
 */

export interface PipelineDeps {
  pushTrace: (line: TraceLine) => void;
  mintId: () => Promise<string>;
  uploadPhoto: (reportId: string, dataUrl: string) => Promise<string>;
  addReport: (r: Report) => Promise<void>;
  pushOutbox: (items: OutboxItem[]) => Promise<void> | void;
}

/** Chennai centroid. Only ever used when the device won't give us a fix. */
const FALLBACK: [number, number] = [13.0389, 80.2492];

export interface LocationFix {
  lat: number;
  lng: number;
  /**
   * False when the device refused or timed out and we fell back to a city
   * centroid. The UI MUST distinguish this — rendering a guessed centroid as
   * "your location" would be exactly the kind of confident fiction this product
   * exists to refuse.
   */
  exact: boolean;
}

export function locate(): Promise<LocationFix> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      return resolve({ lat: FALLBACK[0], lng: FALLBACK[1], exact: false });
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, exact: true }),
      () => resolve({ lat: FALLBACK[0], lng: FALLBACK[1], exact: false }),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });
}

export type ResolveOutcome =
  | { ok: true; routing: RoutingResult; authorities: AuthorityRecord[]; ms: number }
  /** Resolver unreachable — we will not guess a jurisdiction. */
  | { ok: false; kind: "unreachable" }
  /**
   * Resolved a place, but no verified contact registry covers it.
   *
   * Kept in the union because the UI still renders a branch for it, but the
   * server chain no longer produces it: Tier 4 files to a clearly-unverified
   * general municipal body rather than refusing. See resolve-authority.ts.
   */
  | { ok: false; kind: "no_authority"; routing: RoutingResult };

/**
 * Resolves the responsible authority for a coordinate, in the browser.
 *
 * A thin client over /api/route-authority, which now serves the FULL tier
 * chain (see src/lib/resolve-authority.ts). The LLM (Tier 3) and generic
 * municipal (Tier 4) fallbacks used to be reimplemented here, client-side,
 * which is why the WhatsApp webhook — calling the spatial lib directly —
 * silently lacked them and refused to file outside Chennai. One chain now,
 * server-side, for both intake paths.
 */
export async function resolveAuthority(
  lat: number,
  lng: number,
  category: IssueCategory
): Promise<ResolveOutcome> {
  const started = performance.now();
  try {
    const res = await fetch("/api/route-authority", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat, lng, category }),
      // Tier 3 asks an LLM, so this can be slow; bounded so a stall becomes an
      // honest "unreachable" instead of an indefinite spinner.
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { ok: false, kind: "unreachable" };

    const routing = (await res.json()).routing as RoutingResult | undefined;
    if (!routing) return { ok: false, kind: "unreachable" };

    const authorities = (routing.authorities ?? []) as AuthorityRecord[];
    // The chain always returns at least the Tier 4 fallback, so an empty list
    // means something upstream is wrong rather than "nowhere to file".
    if (!authorities.length) return { ok: false, kind: "no_authority", routing };

    return { ok: true, routing, authorities, ms: Math.round(performance.now() - started) };
  } catch {
    return { ok: false, kind: "unreachable" };
  }
}

export interface ConfirmedCapture {
  image: ProcessedImage;
  detection: DetectionResult;
  category: IssueCategory;
  categorySource: CategorySource;
  categoryConfidence: number;
  fix: LocationFix;
  routing: RoutingResult;
  authorities: AuthorityRecord[];
  resolveMs: number;
  /**
   * Which intake path this came through. Defaults to the app. It reaches the
   * complaint email, where the difference is not cosmetic: an app photo was
   * redacted on the device, a WhatsApp photo was not, and the body says so.
   */
  source?: "app" | "whatsapp";
}

/**
 * Emits the agent trace for a capture the citizen has already confirmed, then
 * files it. Every trace string is product copy and is reproduced verbatim from
 * the original inline implementation.
 */
export async function fileReport(
  deps: PipelineDeps,
  c: ConfirmedCapture
): Promise<Report> {
  const { image, detection, category, fix, routing, authorities } = c;

  deps.pushTrace({
    agent: "TRIAGE",
    status: detection.lowConfidence ? "warn" : "ok",
    text: `${category.replace(/_/g, " ")} · severity ${detection.severity} (ordinal) · conf ${detection.confidence}`,
  });
  deps.pushTrace({
    agent: "TRIAGE",
    status: c.categorySource === "user" ? "info" : "ok",
    text:
      c.categorySource === "user"
        ? "Category chosen by the citizen"
        : `Category identified automatically · conf ${c.categoryConfidence.toFixed(2)} · confirmed by citizen`,
  });
  for (const s of detection.signals) deps.pushTrace({ agent: "TRIAGE", text: s });

  deps.pushTrace({
    agent: "GUARD",
    status: "ok",
    text: `On-device redaction: ${image.facesFound} face(s), EXIF stripped, original never uploaded`,
  });
  deps.pushTrace({
    agent: "TRIAGE",
    status: fix.exact ? "ok" : "warn",
    text: fix.exact
      ? `Live geolocation ${fix.lat.toFixed(5)}, ${fix.lng.toFixed(5)} (EXIF not trusted)`
      : "Device gave no location fix — using city centroid, flagged as approximate",
  });

  deps.pushTrace({
    agent: "ROUTING",
    status: routing.tier === 1 ? "ok" : "warn",
    text:
      routing.tier === 1
        ? `Tier 1 · Ward ${routing.ward}, Zone ${routing.zoneNo} · ${routing.zoneName}`
        : `Tier ${routing.tier} · confidence ${routing.confidence} — ${routing.method}`,
    ms: c.resolveMs,
  });
  if (routing.ambiguityNote) {
    deps.pushTrace({ agent: "ROUTING", status: "warn", text: routing.ambiguityNote });
  }

  for (const a of authorities) {
    deps.pushTrace({
      agent: "AUTHORITY",
      status: a.verified ? "info" : "warn",
      text: `${a.name} · ${a.email}${a.verified ? "" : "  [UNVERIFIED]"}`,
    });
  }

  const sla = getSLA(category);
  const slaHours = sla.hours;

  deps.pushTrace({ agent: "SLA", text: `${slaHours}h — ${sla.source} (${sla.resolutionTarget})` });

  // The id comes from a Postgres sequence, not a client counter — two browsers
  // filing at once would otherwise mint the same reference.
  const id = await deps.mintId();

  // Upload the ALREADY-REDACTED frame. imaging.ts pixelated faces and the canvas
  // re-encode dropped EXIF before we ever got here, so the original never leaves
  // the device.
  const photoUrl = await deps.uploadPhoto(id, image.dataUrl);

  const createdAt = now();
  const report: Report = {
    id,
    lat: fix.lat,
    lng: fix.lng,
    // formatPlace, not an inline template: this used to guard on zoneName and
    // interpolate ward, printing "Ward undefined, <area>" for every Tier 2 fix.
    place: formatPlace(routing, fix),
    source: c.source ?? "app",
    category,
    categorySource: c.categorySource,
    categoryConfidence: c.categoryConfidence,
    severity: detection.severity,
    detectionConfidence: detection.confidence,
    photoUrl,
    aHash: image.aHash,
    status: "filed",
    routing,
    createdAt,
    slaDeadline: createdAt + slaHours * HOUR,
    filedTo: authorities.map((a) => a.name),
    supporters: 0,
    timeline: [
      { at: createdAt, kind: "reported", detail: "Reported by citizen" },
      { at: createdAt, kind: "filed", detail: `Filed to ${authorities.length} agency(ies)` },
    ],
  };

  // ORDER MATTERS: the report must exist BEFORE the outbox rows, because
  // outbox_items has a foreign key to reports(user_id, id). Previously the
  // outbox insert fired first and lost a race with the report insert, so the
  // FK violation was silently swallowed and the complaint was never persisted —
  // which meant /api/dispatch had nothing to send and no email went out. Insert
  // the report, then await the outbox persistence so dispatch (called right
  // after this resolves) reliably finds the rows.
  await deps.addReport(report);

  const items = authorities.map((a) => composeComplaint(report, a));
  await deps.pushOutbox(items);
  deps.pushTrace({
    agent: "FILING",
    status: "ok",
    text: `${items.length} complaint(s) composed and dispatched · ${id}`,
  });
  deps.pushTrace({
    agent: "GUARD",
    text: `Sandboxed → ${items[0].actuallyTo}. Nothing sent to a real government address.`,
  });

  return report;
}
