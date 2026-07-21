import { TwitterApi } from "twitter-api-v2";

/**
 * X (Twitter) v2 client. SERVER-ONLY, Node runtime.
 *
 * Hybrid: real posting happens ONLY when all four OAuth 1.0a user tokens are
 * set. Absent → the caller simulates (stores the post in-app without sending),
 * exactly the graceful-degradation pattern used for Gemini and Gmail. Real
 * posting is outward-facing and needs an X developer app with write access.
 */

export function xConfigured(): boolean {
  return Boolean(
    process.env.X_API_KEY &&
      process.env.X_API_SECRET &&
      process.env.X_ACCESS_TOKEN &&
      process.env.X_ACCESS_SECRET
  );
}

export interface XPostResult {
  id: string;
  url: string;
}

export async function postToX(input: {
  text: string;
  image?: { content: Buffer; mimeType: string } | null;
}): Promise<XPostResult> {
  if (typeof window !== "undefined") {
    throw new Error("x-client must never run in the browser.");
  }

  const client = new TwitterApi({
    appKey: process.env.X_API_KEY!,
    appSecret: process.env.X_API_SECRET!,
    accessToken: process.env.X_ACCESS_TOKEN!,
    accessSecret: process.env.X_ACCESS_SECRET!,
  });
  const rw = client.readWrite;

  // Attach the evidence photo natively (no link — 13× cheaper and X-compliant).
  let mediaId: string | undefined;
  if (input.image) {
    try {
      mediaId = await rw.v1.uploadMedia(input.image.content, {
        mimeType: input.image.mimeType,
      });
    } catch {
      // Media upload failed (v1.1 access not granted) — post text-only.
    }
  }

  const res = await rw.v2.tweet(
    mediaId
      ? { text: input.text, media: { media_ids: [mediaId] as [string] } }
      : { text: input.text }
  );

  const id = res.data.id;
  return { id, url: `https://x.com/i/web/status/${id}` };
}
