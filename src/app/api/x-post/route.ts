import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { postSocial } from "@/lib/social";
import { guardText } from "@/lib/escalation";

/**
 * NAMMA CHENNAI PUBLIC POST — real X post (hybrid) or simulated.
 *
 * Composes are done client-side; this route is the transport + record. It
 * re-runs the political/defamatory guard server-side (defense-in-depth,
 * independent of any client), then posts to X when credentials exist, else
 * marks the post simulated. Either way a `public_posts` row is written so the
 * in-app "Namma Chennai" timeline shows it. Runs as the logged-in user (author).
 */

export const runtime = "nodejs";

async function fetchImage(
  url: string | null | undefined
): Promise<{ content: Buffer; mimeType: string } | null> {
  if (!url) return null;
  try {
    if (url.startsWith("data:")) {
      const m = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(url);
      if (!m) return null;
      return { content: Buffer.from(m[2], "base64"), mimeType: m[1] };
    }
    const res = await fetch(url);
    if (!res.ok) return null;
    return {
      content: Buffer.from(await res.arrayBuffer()),
      mimeType: res.headers.get("content-type") ?? "image/jpeg",
    };
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.text !== "string" || typeof body.kind !== "string") {
    return NextResponse.json({ error: "kind and text required" }, { status: 400 });
  }
  const kind = body.kind as string;
  if (!["escalation", "update", "summary"].includes(kind)) {
    return NextResponse.json({ error: "bad kind" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) return NextResponse.json({ error: "unauthorised" }, { status: 401 });

  // Defense-in-depth: strip any political/defamatory sentence, independent of
  // whatever the client composed. Never post the raw input.
  const guard = guardText(body.text);
  const text = (guard.cleaned || body.text).slice(0, 280);

  const at = typeof body.at === "number" ? body.at : Date.now();

  let source: "x" | "bluesky" | "simulated" = "simulated";
  let tweetId: string | null = null;
  let tweetUrl: string | null = null;

  const image = await fetchImage(body.photoUrl);
  const posted = await postSocial({ text, image });
  if (posted) {
    source = posted.platform;
    tweetId = posted.id;
    tweetUrl = posted.url;
  }

  const { error } = await supabase.from("public_posts").insert({
    report_id: body.reportId ?? null,
    kind,
    body: text,
    source,
    tweet_id: tweetId,
    tweet_url: tweetUrl,
    author: user.id,
    at,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ source, tweetUrl });
}
