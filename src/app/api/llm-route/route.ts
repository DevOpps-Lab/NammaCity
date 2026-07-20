import { NextResponse, type NextRequest } from "next/server";

/**
 * LLM ROUTING FALLBACK
 *
 * Only called when the deterministic spatial routing (routing.ts) resolves a
 * location but finds no verified contact registry for it — i.e., outside
 * Chennai where we have no ward polygon data.
 *
 * The primary routing system (Tier 1 GCC polygons + Tier 2 OSM) remains
 * completely untouched. This endpoint fires only on the no_authority path.
 *
 * The LLM is given the city name (from Tier 2 OSM) and the issue category, and
 * asked to return the most plausible municipal department with its contact.
 * The result is explicitly marked verified: false — the outbox already flags
 * unverified contacts and the UI renders them with a warning.
 */

export const runtime = "nodejs";

const MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
const ENDPOINT = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

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

function parseLoosely(text: string): Record<string, unknown> | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

export async function POST(request: NextRequest) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return NextResponse.json({ configured: false }, { status: 200 });
  }

  let city: string, category: string;
  try {
    ({ city, category } = await request.json());
  } catch {
    return NextResponse.json({ error: "Malformed body" }, { status: 400 });
  }

  if (!city || !category) {
    return NextResponse.json({ error: "city and category are required" }, { status: 400 });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);

    const res = await fetch(ENDPOINT(MODEL), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `City: ${city}\nIssue category: ${category.replace(/_/g, " ")}\n\nWhich municipal department handles this?`,
              },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: SCHEMA,
          thinkingConfig: { thinkingBudget: 0 },
          maxOutputTokens: 512,
        },
      }),
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const detail = await res.text();
      return NextResponse.json(
        { configured: true, error: `Gemini ${res.status}: ${detail.slice(0, 200)}` },
        { status: 502 }
      );
    }

    const payload = await res.json();
    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return NextResponse.json({ configured: true, refused: true }, { status: 200 });
    }

    const parsed = parseLoosely(text);
    if (!parsed) {
      return NextResponse.json(
        { configured: true, error: "Model did not return JSON" },
        { status: 502 }
      );
    }

    return NextResponse.json({
      configured: true,
      name: String(parsed.name ?? "Municipal Department"),
      email: String(parsed.email ?? ""),
      handle: parsed.handle ? String(parsed.handle) : undefined,
      slaHours: Math.max(1, Number(parsed.slaHours) || 72),
      slaSource: String(parsed.slaSource ?? "LLM estimate — not a verified charter"),
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
    });
  } catch (error) {
    return NextResponse.json(
      {
        configured: true,
        error: error instanceof Error ? error.message : "Routing failed",
      },
      { status: 502 }
    );
  }
}
