/**
 * Parses JSON from a model response that may be wrapped in prose or a fenced
 * code block, despite having been asked for `responseMimeType: application/json`.
 *
 * Lived in duplicate — byte-identical — in the vision and LLM-routing modules.
 * One copy, since a fix to one should never be a fix to only one.
 */
export function parseLoosely(text: string): Record<string, unknown> | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    // Sometimes the model prefixes a sentence. Take the outermost braces.
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
