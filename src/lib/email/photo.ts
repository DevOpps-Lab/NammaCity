import type { MailAttachment } from "./gmail";

/**
 * The report photo, as an inline mail attachment.
 *
 * Shared because it was not, and the complaint email is where that cost the
 * most. /api/dispatch (the in-app path) fetched and attached the photo;
 * `dispatchComplaints` in lib/whatsapp/intake.ts sent the same composed body
 * with no attachment at all. So every WhatsApp complaint reached the authority
 * saying "A geotagged photograph is attached" with nothing attached — a
 * complaint with no evidence, which is the only part an engineer at a municipal
 * body actually needs.
 *
 * intake.ts opens by warning that a divergent second intake path "would quietly
 * become a second-class citizen with its own bugs". This was that bug.
 *
 * The `cid` is what lets the HTML body render the photo inline via
 * `cid:reportphoto` rather than leaving it as a download.
 */
export const REPORT_PHOTO_CID = "reportphoto";

export async function fetchReportPhoto(
  photoUrl: string | null | undefined,
  reportId: string
): Promise<MailAttachment | null> {
  if (!photoUrl) return null;
  try {
    if (photoUrl.startsWith("data:")) {
      const m = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(photoUrl);
      if (!m) return null;
      return {
        filename: `${reportId}.jpg`,
        content: Buffer.from(m[2], "base64"),
        contentType: m[1],
        cid: REPORT_PHOTO_CID,
      };
    }
    const res = await fetch(photoUrl);
    if (!res.ok) return null;
    return {
      filename: `${reportId}.jpg`,
      content: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") ?? "image/jpeg",
      cid: REPORT_PHOTO_CID,
    };
  } catch {
    // A complaint with no photo still beats no complaint — but the body must
    // not then claim one is attached. See composeComplaint.
    return null;
  }
}
