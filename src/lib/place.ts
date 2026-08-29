import type { RoutingResult } from "./types";

/**
 * The one place a routing result is turned into a human-readable location.
 *
 * THE BUG THIS EXISTS TO KILL. Three call sites independently wrote
 * `routing.zoneName ? \`Ward ${routing.ward}, ${routing.zoneName}\` : …` —
 * guarding on `zoneName` but interpolating `ward`. Tier 2 (OSM reverse geocode)
 * legitimately returns an area name with NO ward number, because most of India
 * has no published numbered wards. So every Tier 2 report rendered as the
 * literal string "Ward undefined, Varadarajapuram", on the report sheet, in the
 * ledger, and on the public feed.
 *
 * `routing.method` had always described this correctly — it has a separate
 * branch for "no numbered ward published for this area". Only the display
 * string was wrong, which is why it survived: nothing that reads `method` ever
 * looked broken.
 *
 * Client-safe on purpose. `routing.ts` reads the ward GeoJSON through node:fs,
 * so a component cannot import the resolver — which is exactly how the three
 * copies came to exist in the first place.
 */
export function formatPlace(
  routing: Pick<RoutingResult, "ward" | "zoneName" | "cityName">,
  fallback?: { lat: number; lng: number }
): string {
  const { ward, zoneName, cityName } = routing;

  // A numbered ward is the most precise thing we can say, so it leads.
  if (ward !== undefined && ward !== null) {
    return zoneName ? `Ward ${ward}, ${zoneName}` : `Ward ${ward}`;
  }

  // No ward number: name the locality, and the city too when it adds something.
  if (zoneName) {
    return cityName && cityName !== zoneName ? `${zoneName}, ${cityName}` : zoneName;
  }
  if (cityName) return cityName;

  if (fallback) return `~${fallback.lat.toFixed(4)}, ${fallback.lng.toFixed(4)}`;
  return "Location not resolved";
}
