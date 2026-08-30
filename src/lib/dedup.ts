import type { Report, IssueCategory } from "./types";
import { hammingDistance } from "./imaging";

/**
 * DUPLICATE DETECTION
 *
 * No published method exists for civic reports specifically, so this composes
 * the standard parts: spatial proximity first, then perceptual-hash similarity
 * to confirm.
 *
 * Why geo does the heavy lifting and the hash only confirms:
 *  - Phone GPS is accurate to 3-5m, which is WORSE than the 2.5m Haversine
 *    threshold used in the video-based literature. Geometry alone will both
 *    over- and under-merge in dense streets.
 *  - Average/perceptual hashes are robust to compression and brightness but NOT
 *    to viewpoint change — which is exactly what two people photographing the
 *    same pothole from different angles produce. So a hash MISS is not evidence
 *    of a different defect; only a hash HIT is strong evidence of the same one.
 *
 * Following FixMyStreet, the resolution is never a silent merge: we surface
 * "others already reported this — add your voice?" and let the person decide.
 * FixMyStreet also varies the radius per category, which we do below.
 */

/** Radius in metres within which two reports of a category may be the same thing. */
const RADIUS_BY_CATEGORY: Record<IssueCategory, number> = {
  pothole: 20,
  storm_water_drain: 35,
  sewage_overflow: 35,
  garbage: 40,
  // A streetlight is a discrete pole; two lights 25m apart are different lights.
  streetlight: 15,
  other: 30,
};

/** aHash distance below which two photos are considered the same scene. */
const HASH_MATCH_THRESHOLD = 12;

export function haversineMetres(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number
): number {
  const R = 6_371_000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) *
      Math.cos((bLat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export interface DuplicateCandidate {
  report: Report;
  distanceM: number;
  hashDistance?: number;
  confidence: "high" | "medium" | "low";
  reason: string;
}

export function findDuplicates(
  candidate: { lat: number; lng: number; category: IssueCategory; aHash?: string },
  existing: Report[]
): DuplicateCandidate[] {
  const radius = RADIUS_BY_CATEGORY[candidate.category];
  const out: DuplicateCandidate[] = [];

  for (const r of existing) {
    // Never merge into something already closed — a recurring defect at the
    // same spot is a NEW report, and recurrence is itself a signal worth
    // surfacing (DARPG found 5 lakh recurring grievances 2022-25).
    if (r.status === "verified_fixed") continue;
    if (r.category !== candidate.category) continue;

    const distanceM = haversineMetres(candidate.lat, candidate.lng, r.lat, r.lng);
    if (distanceM > radius) continue;

    const hashDistance =
      candidate.aHash && r.aHash
        ? hammingDistance(candidate.aHash, r.aHash)
        : undefined;

    let confidence: DuplicateCandidate["confidence"] = "low";
    let reason = `${distanceM.toFixed(0)}m away`;

    if (hashDistance !== undefined && hashDistance <= HASH_MATCH_THRESHOLD) {
      confidence = "high";
      reason = `${distanceM.toFixed(0)}m away, photos look like the same scene`;
    } else if (distanceM <= radius * 0.4) {
      confidence = "medium";
      reason = `${distanceM.toFixed(0)}m away and very close, but the photos differ`;
    } else if (hashDistance !== undefined) {
      // Explicitly do NOT downgrade below "low" on a hash miss: different
      // viewpoints of the same pothole legitimately produce different hashes.
      reason = `${distanceM.toFixed(0)}m away at a different angle, may still be the same issue`;
    }

    out.push({ report: r, distanceM, hashDistance, confidence, reason });
  }

  return out.sort((a, b) => a.distanceM - b.distanceM).slice(0, 4);
}
