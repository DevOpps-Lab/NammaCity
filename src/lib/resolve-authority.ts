import type { IssueCategory, RoutingResult } from "./types";
import type { AuthorityRecord } from "./authorities";
import { genericMunicipalAuthority } from "./authorities";
import { resolveAuthority as spatialResolve } from "./routing";
import { routeByLLM, llmAuthority } from "./llm-route";

/**
 * THE FULL AUTHORITY-ROUTING CHAIN — one implementation, server-side.
 *
 * SERVER ONLY. It reads the ward GeoJSON off disk through `./routing`
 * (`node:fs`), so importing it from a client component breaks the bundle.
 * Reach it from the browser via /api/route-authority instead.
 *
 * Tier 1 (Chennai ward polygons) and Tier 2 (OSM reverse geocode) live in
 * `routing.ts`. Tiers 3 and 4 used to live in `pipeline.ts#resolveAuthority`,
 * which reaches them over a RELATIVE fetch and is therefore browser-only. The
 * WhatsApp webhook called `routing.ts` directly, so it only ever saw Tiers 1-2
 * — and since Tier 2 returns `authorities: []` by design, every report outside
 * the Chennai ward polygons was refused with "no verified contact ... we won't
 * file blind", while the same photo filed fine in the app.
 *
 * That asymmetry is the bug this module exists to remove. Both intake paths now
 * resolve through here.
 *
 * The tiers, and what each means:
 *   1  ward polygon hit          — verified registry, high confidence
 *   2  place known, no registry  — falls through to 3
 *   3  LLM names a department    — UNVERIFIED contact, filed anyway
 *   4  nothing known             — generic municipal body, UNVERIFIED
 *
 * Filing with an unverified contact is a deliberate product choice, not a
 * shortcut: refusing would exclude most of India, and every unverified record
 * is labelled as such in the outbox, the trace and the UI.
 */

/**
 * Below this, the LLM's answer is discarded in favour of the generic municipal
 * fallback.
 *
 * The prompt instructs the model to return confidence < 0.3 when it does not
 * know the city, and taking it at its word matters: a *named* department the
 * model half-invented reads as authoritative on a complaint, while the Tier 4
 * fallback is transparently generic. When we are guessing, it is better to look
 * like we are guessing.
 */
const LLM_MIN_CONFIDENCE = 0.3;

export type ResolveOutcome =
  | { ok: true; routing: RoutingResult; authorities: AuthorityRecord[]; ms: number }
  /** Spatial resolver itself threw — we will not guess a jurisdiction. */
  | { ok: false; kind: "unreachable" };

export async function resolveAuthorityFull(
  lat: number,
  lng: number,
  category: IssueCategory
): Promise<ResolveOutcome> {
  const started = Date.now();

  let routing: RoutingResult;
  try {
    routing = await spatialResolve(lat, lng, category);
  } catch (error) {
    // routing.ts reads the ward GeoJSON off disk; a missing or corrupt file
    // throws. Report it rather than pretending we resolved something.
    console.error("[resolve-authority] spatial routing failed", error);
    return { ok: false, kind: "unreachable" };
  }

  // --- Tier 1 hit: a verified registry covers this location -----------------
  const existing = (routing.authorities ?? []) as AuthorityRecord[];
  if (existing.length) {
    return { ok: true, routing, authorities: existing, ms: Date.now() - started };
  }

  // --- Tier 3: the LLM may know the department for this city ----------------
  // Gated on a city name because that is the only useful input we have; when
  // Tier 2 failed entirely there is nothing to ask about, so we skip to Tier 4.
  if (routing.cityName) {
    const result = await routeByLLM(routing.cityName, category);
    if (result.ok && result.route.confidence >= LLM_MIN_CONFIDENCE) {
      const authority = llmAuthority(routing.cityName, category, result.route);
      return {
        ok: true,
        routing: {
          ...routing,
          tier: 3,
          confidence: "low",
          method: `LLM routing fallback for ${routing.cityName} — deterministic registry had no contact. confidence ${result.route.confidence.toFixed(2)}`,
          authorities: [authority],
          ambiguityNote:
            "Contact resolved by LLM, not a verified primary source. Marked unverified in the outbox.",
        },
        authorities: [authority],
        ms: Date.now() - started,
      };
    }
    if (!result.ok && result.kind !== "unconfigured") {
      console.warn(`[resolve-authority] LLM tier unavailable (${result.kind})`);
    } else if (result.ok) {
      console.info(
        `[resolve-authority] LLM route for ${routing.cityName} rejected — confidence ${result.route.confidence.toFixed(2)} < ${LLM_MIN_CONFIDENCE}`
      );
    }
  }

  // --- Tier 4: a general municipal body, clearly unverified -----------------
  const place = routing.cityName ?? "this location";
  const fallback = genericMunicipalAuthority(routing.cityName, category);
  return {
    ok: true,
    routing: {
      ...routing,
      tier: 4,
      confidence: "low",
      method: `No verified registry for ${place} and LLM routing unavailable — filed to a general municipal body (unverified).`,
      authorities: [fallback],
      ambiguityNote:
        "Contact is a general municipal fallback, not a verified primary source. Marked unverified in the outbox.",
    },
    authorities: [fallback],
    ms: Date.now() - started,
  };
}
