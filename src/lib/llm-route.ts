import type { IssueCategory } from "./types";
import type { AuthorityRecord } from "./authorities";
import { parseLoosely } from "./json-loose";

/**
 * LLM ROUTING FALLBACK (Tier 3) — the provider call, in one place.
 *
 * Fires only when deterministic spatial routing resolves a *place* but has no
 * verified contact registry for it — i.e. outside the ~28 Indian urban local
 * bodies with open ward polygons. Tiers 1 and 2 are untouched by this.
 *
 * This was inline in `/api/llm-route/route.ts`, which was fine while only the
 * browser needed it. The WhatsApp webhook needs the same fallback server-side
 * and cannot reach that route: it is behind the auth proxy, so a cookieless
 * request is redirected to /login and `res.json()` would parse an HTML page.
 * Same reasoning, and same shape, as `src/lib/vision.ts`.
 *
 * The result is ALWAYS marked `verified: false`. The outbox flags unverified
 * contacts and the UI renders them with a warning — an address a language model
 * recalled is not a primary source, and the product's whole claim rests on that
 * distinction being visible.
 */

// gemini-2.5-flash was retired for new API keys — Google 404s it with
// "no longer available to new users". Override with GEMINI_MODEL.
const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.6-flash";
const ENDPOINT = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

/**
 * One budget for the whole call.
 *
 * Previously there were two, fighting: a 4s `Promise.race` in pipeline.ts
 * wrapping an 8s AbortController here. Any response slower than 4s lost the
 * race — and because `Promise.race` does not cancel the loser, the request ran
 * on regardless, so the 8s abort never meaningfully fired. One timeout, applied
 * to the actual fetch.
 */
const TIMEOUT_MS = 6_000;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    name: { type: "STRING" },
    email: { type: "STRING" },
    handle: { type: "STRING" },
    slaHours: { type: "NUMBER" },
    slaSource: { type: "STRING" },
    confidence: { type: "NUMBER" },
  },
  required: ["name", "slaHours", "slaSource", "confidence"],
};

const SYSTEM = `You are a civic infrastructure routing assistant for Indian cities.

Given a city name and a civic issue category, return the most likely responsible
municipal department with its known contact details.

Rules:
- Return only role-based emails (e.g. commissioner@, sewage@) — never a named person.
- If you do not know the exact email, return an empty string for email.
- slaHours should be your best estimate of the official SLA in hours based on known charters.
- slaSource should name the charter or regulation you are citing.
- confidence is how certain you are about the routing (0-1).
- If the city is completely unknown to you, return confidence < 0.3.`;

export interface LLMRoute {
  name: string;
  email: string;
  handle?: string;
  slaHours: number;
  slaSource: string;
  confidence: number;
}

export type LLMRouteResult =
  | { ok: true; route: LLMRoute }
  | { ok: false; kind: "unconfigured" }
  | { ok: false; kind: "refused" }
  | { ok: false; kind: "rateLimited"; error: string }
  | { ok: false; kind: "error"; error: string };

export function llmRoutingConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

export async function routeByLLM(
  city: string,
  category: IssueCategory | string
): Promise<LLMRouteResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { ok: false, kind: "unconfigured" };
  if (!city || !category) {
    return { ok: false, kind: "error", error: "city and category are required" };
  }

  try {
    const res = await fetch(ENDPOINT(MODEL), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `City: ${city}\nIssue category: ${String(category).replace(/_/g, " ")}\n\nWhich municipal department handles this?`,
              },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: SCHEMA,
          // No thinkingConfig: `thinkingBudget: 0` was a latency/cost trim on
          // 2.5-flash, and gemini-3.x rejects the whole request with a bare
          // 400 "invalid argument" for it — which surfaces here as an
          // unexplained refusal to verify. Not worth re-adding under a
          // version sniff for the milliseconds it saved.
          maxOutputTokens: 512,
        },
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error(`[llm-route] Gemini ${res.status}:`, detail.slice(0, 300));
      const error = `Gemini ${res.status}: ${detail.slice(0, 200)}`;
      // Distinguished so callers can say "quota spent" rather than "failed" —
      // the old route lumped 429 in with every other error.
      return res.status === 429
        ? { ok: false, kind: "rateLimited", error }
        : { ok: false, kind: "error", error };
    }

    const payload = await res.json();
    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return { ok: false, kind: "refused" };

    const parsed = parseLoosely(text);
    if (!parsed) return { ok: false, kind: "error", error: "Model did not return JSON" };

    return {
      ok: true,
      route: {
        name: String(parsed.name ?? "Municipal Department"),
        email: String(parsed.email ?? ""),
        handle: parsed.handle ? String(parsed.handle) : undefined,
        slaHours: Math.max(1, Number(parsed.slaHours) || 72),
        slaSource: String(parsed.slaSource ?? "LLM estimate, not a verified charter"),
        confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
      },
    };
  } catch (error) {
    // AbortSignal.timeout surfaces as a TimeoutError here.
    return {
      ok: false,
      kind: "error",
      error: error instanceof Error ? error.message : "Routing failed",
    };
  }
}

/** Shapes an LLM answer into an authority record, always unverified. */
export function llmAuthority(
  city: string,
  category: IssueCategory,
  route: LLMRoute
): AuthorityRecord {
  return {
    id: `llm-${city.toLowerCase().replace(/\s+/g, "-")}-${category}`,
    name: route.name,
    email: route.email,
    handle: route.handle,
    slaHours: route.slaHours,
    slaSource: route.slaSource,
    // ALWAYS false. A contact recalled by a model is not a primary source.
    verified: false,
    source: `LLM routing fallback for ${city} (${category})`,
    categories: [category],
  };
}
