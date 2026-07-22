import { AtpAgent, RichText } from "@atproto/api";

/**
 * BLUESKY posting. SERVER-ONLY, Node runtime.
 *
 * A free, public, X-like alternative for the Namma Chennai timeline — no API
 * credits, no approval. Auth is a handle + an app password (created in Bluesky
 * Settings), so a bot can post from one account with no login-redirect flow,
 * exactly like the OAuth-1.0a X path.
 */

export function blueskyConfigured(): boolean {
  return Boolean(process.env.BLUESKY_IDENTIFIER && process.env.BLUESKY_APP_PASSWORD);
}

export interface SocialResult {
  id: string;
  url: string;
}

export async function postToBluesky(input: {
  text: string;
  image?: { content: Buffer; mimeType: string } | null;
}): Promise<SocialResult> {
  if (typeof window !== "undefined") {
    throw new Error("bluesky-client must never run in the browser.");
  }

  const agent = new AtpAgent({ service: "https://bsky.social" });
  await agent.login({
    identifier: process.env.BLUESKY_IDENTIFIER!,
    password: process.env.BLUESKY_APP_PASSWORD!,
  });

  // RichText resolves #hashtags / links into facets so they render as links.
  const rt = new RichText({ text: input.text.slice(0, 300) });
  await rt.detectFacets(agent);

  let embed: Parameters<typeof agent.post>[0]["embed"];
  if (input.image) {
    try {
      const up = await agent.uploadBlob(input.image.content, {
        encoding: input.image.mimeType,
      });
      embed = {
        $type: "app.bsky.embed.images",
        images: [{ image: up.data.blob, alt: "Reported civic defect (redacted on device)" }],
      };
    } catch {
      // Image too large / upload failed — post text-only.
    }
  }

  const res = await agent.post({
    text: rt.text,
    facets: rt.facets,
    ...(embed ? { embed } : {}),
  });

  const rkey = res.uri.split("/").pop();
  const handle = agent.session?.handle ?? process.env.BLUESKY_IDENTIFIER!;
  return { id: res.uri, url: `https://bsky.app/profile/${handle}/post/${rkey}` };
}
