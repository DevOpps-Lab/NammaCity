import { NextResponse } from "next/server";
import { resolveAuthority } from "@/lib/routing";
import type { IssueCategory } from "@/lib/types";

export async function POST(req: Request) {
  const { lat, lng, category } = await req.json();

  if (typeof lat !== "number" || typeof lng !== "number") {
    return NextResponse.json({ error: "lat and lng required" }, { status: 400 });
  }

  const started = Date.now();
  const routing = await resolveAuthority(
    lat,
    lng,
    (category as IssueCategory) ?? "pothole"
  );

  return NextResponse.json({ routing, ms: Date.now() - started });
}
