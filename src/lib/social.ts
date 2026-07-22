import { xConfigured, postToX } from "./x-client";
import { blueskyConfigured, postToBluesky } from "./bluesky-client";

/**
 * One entry point for a Namma Chennai public post, across platforms.
 *
 * Tries Bluesky first (free, no credits) then X, so the app posts to whichever
 * is configured. Returns the platform + post URL, or null when neither is
 * configured or both fail — in which case the caller records the post as
 * "simulated" so the in-app timeline still shows it.
 */

export type SocialPlatform = "x" | "bluesky";

export interface SocialImage {
  content: Buffer;
  mimeType: string;
}

export function socialConfigured(): boolean {
  return blueskyConfigured() || xConfigured();
}

export async function postSocial(input: {
  text: string;
  image?: SocialImage | null;
}): Promise<{ platform: SocialPlatform; id: string; url: string } | null> {
  if (blueskyConfigured()) {
    try {
      const r = await postToBluesky(input);
      return { platform: "bluesky", ...r };
    } catch (e) {
      console.error("[social] bluesky post failed:", e instanceof Error ? e.message : e);
    }
  }
  if (xConfigured()) {
    try {
      const r = await postToX(input);
      return { platform: "x", ...r };
    } catch (e) {
      console.error("[social] x post failed:", e instanceof Error ? e.message : e);
    }
  }
  return null;
}
