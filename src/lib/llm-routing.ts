import type { IssueCategory } from "./types";
import type { AuthorityRecord } from "./authorities";

/**
 * LLM ROUTING — client-side wrapper
 *
 * Calls /api/llm-route and formats the response as an AuthorityRecord so
 * the pipeline (pipeline.ts) and UI can treat it identically to a record
 * from the local CHENNAI_AUTHORITIES registry.
 *
 * Critical difference: verified is always false. This is not a verified
 * contact — the outbox already flags unverified addresses and the UI renders
 * them with a warning badge. Never suppress this.
 *
 * This wrapper is ONLY invoked as a fallback when the deterministic routing
 * (routing.ts Tier 1 + Tier 2) returns no_authority.
 */

export interface LLMRoutingResult {
  authority: AuthorityRecord;
  confidence: number;
}

export async function llmRouteAuthority(
  cityName: string,
  category: IssueCategory
): Promise<LLMRoutingResult | null> {
  try {
    const res = await fetch("/api/llm-route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ city: cityName, category }),
    });

    if (!res.ok) return null;

    const data: {
      configured?: boolean;
      refused?: boolean;
      error?: string;
      name?: string;
      email?: string;
      handle?: string;
      slaHours?: number;
      slaSource?: string;
      confidence?: number;
    } = await res.json();

    if (!data.configured || data.refused || data.error || !data.name) return null;

    const authority: AuthorityRecord = {
      id: `llm-${cityName.toLowerCase().replace(/\s+/g, "-")}-${category}`,
      name: data.name,
      email: data.email ?? "",
      handle: data.handle,
      slaHours: data.slaHours ?? 72,
      slaSource: data.slaSource ?? "LLM estimate — not a verified charter",
      // ALWAYS false — this contact was not confirmed from a primary source.
      verified: false,
      source: `LLM routing fallback for ${cityName} (${category})`,
      categories: [category],
    };

    return { authority, confidence: data.confidence ?? 0 };
  } catch {
    return null;
  }
}
