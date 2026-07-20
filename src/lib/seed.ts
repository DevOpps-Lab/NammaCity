import type { Report, ReportStatus, IssueCategory, Severity } from "./types";
import { HOUR } from "./demoClock";

/**
 * SEED DATA
 *
 * The map must look alive the instant it loads — an empty map is the fastest
 * way to lose a room. These are backdated across every lifecycle stage so the
 * feed, the counters and the "Recently Fixed" rail all have content at t=0.
 *
 * Report `demo-breach` is deliberately seeded at 47h59m against a 48h SLA:
 * that is the one you point at and say "watch this" before flipping demo mode.
 *
 * Coordinates are real Chennai locations so they land in real GCC wards via
 * the Tier 1 resolver.
 */

interface SeedSpec {
  id: string;
  lat: number;
  lng: number;
  category: IssueCategory;
  severity: Severity;
  status: ReportStatus;
  /** hours before "now" that this was created */
  ageHours: number;
  slaHours: number;
  supporters: number;
  place: string;
}

const SPECS: SeedSpec[] = [
  // --- Past SLA, escalated: the accountability story -----------------------
  { id: "CA-4471", lat: 13.0389, lng: 80.2492, category: "pothole", severity: "large", status: "escalated", ageHours: 61 * 24, slaHours: 72, supporters: 23, place: "Anna Salai, Teynampet" },
  { id: "CA-4402", lat: 13.0067, lng: 80.2570, category: "storm_water_drain", severity: "large", status: "escalated", ageHours: 44 * 24, slaHours: 72, supporters: 41, place: "Sardar Patel Road, Adyar" },
  { id: "CA-4390", lat: 13.1067, lng: 80.2930, category: "sewage_overflow", severity: "medium", status: "past_sla", ageHours: 12 * 24, slaHours: 72, supporters: 8, place: "Royapuram Market" },
  { id: "CA-4455", lat: 13.0836, lng: 80.2101, category: "pothole", severity: "medium", status: "past_sla", ageHours: 9 * 24, slaHours: 72, supporters: 12, place: "Anna Nagar 2nd Ave" },

  // --- The authority CLAIMS done but nobody has verified -------------------
  // These render hollow/dashed green. The visual difference from a verified
  // fix is the entire product thesis expressed as a UI primitive.
  { id: "CA-4480", lat: 13.0524, lng: 80.2508, category: "pothole", severity: "small", status: "claims_done", ageHours: 5 * 24, slaHours: 72, supporters: 3, place: "Nungambakkam High Road" },
  { id: "CA-4488", lat: 13.0298, lng: 80.2101, category: "garbage", severity: "medium", status: "claims_done", ageHours: 4 * 24, slaHours: 24, supporters: 6, place: "Kodambakkam" },

  // --- Verified fixed: the wins that keep people coming back ---------------
  { id: "CA-4301", lat: 13.0604, lng: 80.2496, category: "pothole", severity: "large", status: "verified_fixed", ageHours: 30 * 24, slaHours: 72, supporters: 34, place: "Egmore Station Road" },
  { id: "CA-4288", lat: 13.0878, lng: 80.2785, category: "storm_water_drain", severity: "medium", status: "verified_fixed", ageHours: 26 * 24, slaHours: 72, supporters: 19, place: "Tondiarpet" },
  { id: "CA-4344", lat: 12.9822, lng: 80.2205, category: "streetlight", severity: "small", status: "verified_fixed", ageHours: 18 * 24, slaHours: 48, supporters: 7, place: "Velachery Main Road" },

  // --- In flight -----------------------------------------------------------
  { id: "CA-4502", lat: 13.1143, lng: 80.1548, category: "sewage_overflow", severity: "medium", status: "acknowledged", ageHours: 20, slaHours: 72, supporters: 5, place: "Ambattur Industrial Estate" },
  { id: "CA-4509", lat: 13.0012, lng: 80.2565, category: "pothole", severity: "small", status: "filed", ageHours: 8, slaHours: 72, supporters: 1, place: "Indira Nagar, Adyar" },
  { id: "CA-4511", lat: 13.0450, lng: 80.2650, category: "garbage", severity: "small", status: "reported", ageHours: 1, slaHours: 24, supporters: 0, place: "Mylapore Tank" },

  // --- Jurisdiction ping-pong: the dodge Bombay HC forbade -----------------
  { id: "CA-4467", lat: 13.0184, lng: 80.2340, category: "storm_water_drain", severity: "large", status: "transferred", ageHours: 15 * 24, slaHours: 72, supporters: 17, place: "Saidapet Bridge" },

  // --- THE DEMO MOMENT ----------------------------------------------------
  // 47h59m into a 48h SLA. Flip demo mode and it breaches live on stage.
  { id: "CA-4520", lat: 13.0731, lng: 80.2609, category: "pothole", severity: "large", status: "filed", ageHours: 47.983, slaHours: 48, supporters: 9, place: "Poonamallee High Road, Chetpet" },
];

export function buildSeedReports(baseNow: number): Report[] {
  return SPECS.map((s) => {
    const createdAt = baseNow - s.ageHours * HOUR;
    const slaDeadline = createdAt + s.slaHours * HOUR;

    const timeline = [
      { at: createdAt, kind: "reported", detail: `Reported at ${s.place}` },
    ];
    if (s.status !== "reported") {
      timeline.push({
        at: createdAt + 2 * 60_000,
        kind: "filed",
        detail: "Complaint dispatched to responsible agencies",
      });
    }
    if (s.status === "transferred") {
      timeline.push({
        at: createdAt + 3 * 24 * HOUR,
        kind: "transferred",
        detail:
          "CMWSSB replied: 'not our jurisdiction, refer GCC'. Re-filed to GCC — SLA clock NOT reset.",
      });
    }
    if (s.status === "claims_done") {
      timeline.push({
        at: createdAt + 3 * 24 * HOUR,
        kind: "claims_done",
        detail: "Authority marked resolved. Awaiting citizen verification — not closed.",
      });
    }
    if (s.status === "escalated") {
      timeline.push({
        at: slaDeadline,
        kind: "past_sla",
        detail: "SLA breached",
      });
      timeline.push({
        at: slaDeadline + 6 * HOUR,
        kind: "escalated",
        detail: "Published to the public accountability ledger",
      });
    }
    if (s.status === "verified_fixed") {
      timeline.push({
        at: createdAt + 4 * 24 * HOUR,
        kind: "claims_done",
        detail: "Authority marked resolved",
      });
      timeline.push({
        at: createdAt + 5 * 24 * HOUR,
        kind: "verified_fixed",
        detail: "Citizen confirmed with an after-photo. Closed.",
      });
    }

    return {
      id: s.id,
      lat: s.lat,
      lng: s.lng,
      place: s.place,
      category: s.category,
      categorySource: "user",
      categoryConfidence: 0,
      severity: s.severity,
      detectionConfidence: 0.72 + ((s.supporters % 5) * 0.05),
      photoUrl: `/data/placeholder-${s.category}.svg`,
      afterPhotoUrl: s.status === "verified_fixed" ? `/data/placeholder-fixed.svg` : undefined,
      status: s.status,
      routing: {
        tier: 1,
        confidence: "high",
        method: "Ward polygon match — GCC open ward dataset",
        cityName: "Greater Chennai Corporation",
        authorities: [],
      },
      createdAt,
      slaDeadline,
      filedTo:
        s.category === "sewage_overflow" || s.category === "storm_water_drain"
          ? ["GCC — Storm Water Drain Department", "CMWSSB — Area Engineer"]
          : ["GCC — Bus Route Roads / Roads Department"],
      supporters: s.supporters,
      escalationPostId: s.status === "escalated" ? `post_${s.id}` : undefined,
      timeline,
    };
  });
}

/* ---------------------------------------------------------------------------
   SEEDED CORRESPONDENCE

   Without this, every seeded report opens to an empty thread and the My Reports
   tab reads as half-built on first login — the correspondence engine is one of
   the more interesting things here and it was invisible until the user acted.

   The three exchanges below are the ones that carry an argument:
     CA-4467  the jurisdiction dodge, and the clock refusing to reset
     CA-4480  an authority declaring done, which does NOT close anything
     CA-4390  a flat rejection, which also does not close anything
--------------------------------------------------------------------------- */

const SINK = "demo-inbox@civicagent.local";
const SWD = "seswd@chennaicorporation.gov.in";

export interface SeedOutboxRow {
  report_id: string;
  kind: "complaint" | "reply" | "post" | "rti";
  at: number;
  intended_to: string;
  actually_to: string;
  subject: string;
  body: string;
  recipient_verified: boolean;
  delivered: boolean;
}

export interface SeedInboundRow {
  report_id: string;
  at: number;
  from_addr: string;
  subject: string;
  body: string;
  kind: string;
}

/** One filed complaint per seeded report, so every thread has a beginning. */
export function buildSeedOutbox(reports: Report[]): SeedOutboxRow[] {
  return reports
    .filter((r) => r.status !== "reported") // not yet dispatched
    .map((r) => ({
      report_id: r.id,
      kind: "complaint" as const,
      at: r.createdAt + 2 * 60_000,
      intended_to: r.filedTo[0] ?? "GCC — Bus Route Roads / Roads Department",
      actually_to: SINK,
      subject: `Civic complaint ${r.id} — ${r.category.replace(/_/g, " ")} at ${r.place}`,
      body: [
        `To: ${r.filedTo[0] ?? "the responsible department"}`,
        ``,
        `A civic defect has been reported by a resident at the location below.`,
        ``,
        `Complaint reference : ${r.id}`,
        `Category            : ${r.category.replace(/_/g, " ")}`,
        `Severity            : ${r.severity} (ordinal assessment; not a measurement)`,
        `Location            : ${r.place}`,
        `Coordinates         : ${r.lat.toFixed(6)}, ${r.lng.toFixed(6)}`,
        ``,
        `This complaint is tracked against your department's own published`,
        `service standard. Nothing in this message is a characterisation of any`,
        `officer.`,
      ].join("\n"),
      recipient_verified: true,
      delivered: true,
    }));
}

/** The replies that make the lifecycle states legible. */
export function buildSeedInbound(reports: Report[]): {
  inbound: SeedInboundRow[];
  replies: SeedOutboxRow[];
} {
  const at = (id: string, offsetDays: number) => {
    const r = reports.find((x) => x.id === id);
    return (r?.createdAt ?? Date.now()) + offsetDays * 24 * 3_600_000;
  };
  const inbound: SeedInboundRow[] = [];
  const replies: SeedOutboxRow[] = [];

  if (reports.some((r) => r.id === "CA-4467")) {
    inbound.push({
      report_id: "CA-4467",
      at: at("CA-4467", 3),
      from_addr: SWD,
      subject: "Re: Civic complaint CA-4467",
      body:
        "This location is not our jurisdiction. Kindly approach CMWSSB for " +
        "further action in this matter.",
      kind: "jurisdiction_transfer",
    });
    replies.push({
      report_id: "CA-4467",
      kind: "reply",
      at: at("CA-4467", 3) + 60_000,
      intended_to: SWD,
      actually_to: SINK,
      subject: "Re: Civic complaint CA-4467",
      body:
        "Re: CA-4467 — noted. Re-filing to CMWSSB for further action. Please " +
        "note the original complaint clock is unchanged; a transfer between " +
        "agencies is not a resolution. Bombay HC, High Court on its own motion " +
        "v. State of Maharashtra (13 Oct 2025), declines to permit agencies to " +
        "create no-man's zones of responsibility.",
      recipient_verified: true,
      delivered: true,
    });
  }

  if (reports.some((r) => r.id === "CA-4480")) {
    inbound.push({
      report_id: "CA-4480",
      at: at("CA-4480", 3),
      from_addr: SWD,
      subject: "Re: Civic complaint CA-4480",
      body: "Work completed. The complaint is being closed at our end.",
      kind: "claims_done",
    });
    replies.push({
      report_id: "CA-4480",
      kind: "reply",
      at: at("CA-4480", 3) + 60_000,
      intended_to: SWD,
      actually_to: SINK,
      subject: "Re: Civic complaint CA-4480",
      body:
        "Re: CA-4480 — thank you. This will be marked resolved once a resident " +
        "confirms with a photograph. Until then it remains open on the public " +
        "ledger as claimed-but-unverified.",
      recipient_verified: true,
      delivered: true,
    });
  }

  if (reports.some((r) => r.id === "CA-4390")) {
    inbound.push({
      report_id: "CA-4390",
      at: at("CA-4390", 4),
      from_addr: SWD,
      subject: "Re: Civic complaint CA-4390",
      body: "This does not fall within the scope of our maintenance works.",
      kind: "rejected",
    });
  }

  return { inbound, replies };
}
