import fs from "node:fs";
import path from "node:path";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point } from "@turf/helpers";
import type { Feature, FeatureCollection, Polygon, MultiPolygon } from "geojson";
import type { IssueCategory, RoutingResult } from "./types";
import { authoritiesFor } from "./authorities";

/**
 * TIERED AUTHORITY RESOLVER
 *
 * Converting a GPS coordinate into "who is responsible" is the actual hard
 * problem in Indian civic tech, and there is no national API for it:
 *   - LGD (lgdirectory.gov.in) has every ward's code but NO geometry
 *   - Survey of India stops at taluk/district
 *   - Bhuvan/ISRO publishes no municipal ward polygons
 *   - Open ward polygons exist for ~28 of ~4,800 ULBs
 *
 * So we degrade through tiers and ALWAYS report which tier answered. A system
 * that says "municipality only, low confidence, please confirm" is more
 * trustworthy than one that silently guesses a ward.
 *
 * Tier 1 was originally meant to be the GCC ArcGIS REST service, but that
 * endpoint returns HTTP 500 (probed 18 Jul 2026), and the Esri Living Atlas
 * ward item is inaccessible. Tier 1 is now a local static dataset instead —
 * which is also strictly more reliable, since it cannot fail mid-demo.
 */

interface WardProps {
  Zone_No: string;
  Ward_No: number;
  Zone_Name: string;
}

let wardCache: FeatureCollection<Polygon | MultiPolygon, WardProps> | null = null;

/**
 * Returns null rather than throwing when the dataset is missing or corrupt.
 *
 * This used to throw straight out of resolveAuthority. That was survivable when
 * only an API route called it (a 500), but it is now on the path for every
 * report including WhatsApp intake, where a throw would abandon a citizen's
 * photo mid-conversation. A missing Chennai dataset should degrade to Tier 2,
 * not take down routing for the whole country.
 */
function loadChennaiWards() {
  if (wardCache) return wardCache;
  try {
    const file = path.join(process.cwd(), "public", "data", "chennai-wards.geojson");
    wardCache = JSON.parse(fs.readFileSync(file, "utf-8"));
    return wardCache!;
  } catch (error) {
    console.error("[routing] Chennai ward dataset unavailable, skipping Tier 1", error);
    return null;
  }
}

/** Tier 1 — local ward polygons. Instant, offline, cannot fail on venue wifi. */
function tier1Chennai(lat: number, lng: number) {
  const wards = loadChennaiWards();
  if (!wards) return null;
  const pt = point([lng, lat]);

  for (const f of wards.features) {
    // Ward_No 0 appears in the source data as an artifact; skip it.
    if (!f.properties?.Ward_No) continue;
    try {
      if (booleanPointInPolygon(pt, f as Feature<Polygon | MultiPolygon>)) {
        return {
          ward: f.properties.Ward_No,
          zoneName: f.properties.Zone_Name,
          zoneNo: f.properties.Zone_No,
        };
      }
    } catch {
      // Malformed geometry in the open dataset — skip rather than fail the request.
      continue;
    }
  }
  return null;
}

/**
 * Tier 2 — OpenStreetMap via Nominatim reverse geocoding.
 *
 * Originally specced against the Overpass `is_in()` API, but the public
 * Overpass instance returned 504 Gateway Timeout under test — too flaky to put
 * on a request path. Nominatim is purpose-built for reverse lookup, is far more
 * reliable, and returns richer administrative detail. Verified 18 Jul 2026:
 *
 *   Bengaluru  -> city_district "Bengaluru Central City Corporation"
 *   Mumbai     -> "S Ward, Mumbai Zone 6"
 *   Chennai    -> "CMWSSB Division 175, Ward 175, Zone 13 Adyar"  (matches Tier 1)
 *
 * Nominatim's usage policy caps this at ~1 req/sec, so results are cached.
 * Never make this a hard dependency — it degrades to Tier 4, loudly.
 */
const geoCache = new Map<string, Tier2Result | null>();

interface Tier2Result {
  cityName: string;
  wardNo?: number;
  areaName?: string;
  isWard: boolean;
}

function parseWardNumber(displayName: string): number | undefined {
  // Nominatim encodes ward numbers inline, e.g. "... Ward 175, Zone 13 Adyar ..."
  const m = displayName.match(/\bWard\s+(\d{1,3})\b/i);
  return m ? Number(m[1]) : undefined;
}

async function tier2Osm(lat: number, lng: number): Promise<Tier2Result | null> {
  const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  if (geoCache.has(key)) return geoCache.get(key)!;

  const url =
    `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}` +
    `&format=jsonv2&zoom=18&addressdetails=1`;

  // Nominatim is a free service with no availability guarantee, and it is now
  // on the path for every report outside Chennai. Without a deadline a hung
  // request stalls the whole resolve — and on WhatsApp that is a citizen
  // waiting on a reply that never comes.
  const res = await fetch(url, {
    headers: { "User-Agent": "civicagent/0.1 (civic issue reporting; dev)" },
    signal: AbortSignal.timeout(5_000),
  });
  // Deliberately NOT cached: a 429 or a blip would otherwise poison this
  // coordinate for the life of the process, since the cache is never evicted.
  // Only successful lookups are worth remembering.
  if (!res.ok) return null;

  const data = await res.json();
  const addr = data.address ?? {};

  // Most specific administrative container available, in descending order.
  const cityName =
    addr.city_district ?? addr.city ?? addr.town ?? addr.municipality ?? addr.county;

  // A real answer with no usable place name — cache it, since re-asking would
  // get the same result.
  if (!cityName) {
    geoCache.set(key, null);
    return null;
  }

  const wardNo = parseWardNumber(data.display_name ?? "");
  const result: Tier2Result = {
    cityName,
    wardNo,
    areaName: addr.suburb ?? addr.neighbourhood,
    isWard: wardNo !== undefined || Boolean(addr.suburb),
  };

  geoCache.set(key, result);
  return result;
}

export async function resolveAuthority(
  lat: number,
  lng: number,
  category: IssueCategory
): Promise<RoutingResult> {
  const { authorities, ambiguityNote } = authoritiesFor(category);

  // --- Tier 1: local ward polygons -----------------------------------------
  const t1 = tier1Chennai(lat, lng);
  if (t1) {
    return {
      tier: 1,
      confidence: "high",
      method: `Ward polygon match, GCC open ward dataset (${t1.zoneName}, Zone ${t1.zoneNo})`,
      ward: t1.ward,
      zoneName: t1.zoneName,
      zoneNo: t1.zoneNo,
      cityName: "Greater Chennai Corporation",
      authorities,
      ambiguityNote,
    };
  }

  // --- Tier 2: OSM administrative boundaries --------------------------------
  try {
    const t2 = await tier2Osm(lat, lng);
    if (t2) {
      const where = [t2.areaName, t2.cityName].filter(Boolean).join(", ");
      return {
        tier: 2,
        confidence: t2.isWard ? "medium" : "low",
        method: t2.wardNo
          ? `OSM ward boundary, Ward ${t2.wardNo}, ${where}`
          : t2.isWard
            ? `OSM locality boundary, ${where}. No numbered ward published for this area.`
            : `OSM municipality only, ${t2.cityName}. No ward-level boundary published for this area.`,
        ward: t2.wardNo,
        zoneName: t2.areaName,
        cityName: t2.cityName,
        // We have a place, but no vetted contact registry outside our Tier 1 cities.
        authorities: [],
        ambiguityNote:
          "Outside our high-resolution coverage. We can name the locality but have no verified contact registry for this body, please confirm the responsible agency before filing.",
      };
    }
  } catch {
    // Nominatim is rate-limited and occasionally down. Fall through honestly
    // rather than guessing a jurisdiction.
  }

  // --- Tier 4: give up loudly, never silently ------------------------------
  return {
    tier: 4,
    confidence: "unresolved",
    method:
      "No boundary data available for this location. Open ward polygons exist for roughly 28 of India's ~4,800 urban local bodies.",
    authorities: [],
    ambiguityNote: "Manual confirmation required, we will not guess a jurisdiction.",
  };
}
