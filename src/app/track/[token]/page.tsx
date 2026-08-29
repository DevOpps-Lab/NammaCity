import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { fetchReportByToken } from "@/lib/db";
import { categoryLabel } from "@/lib/categories";
import { STATUS_STYLES } from "@/lib/status";
import TrackVerify from "@/components/TrackVerify";
import type { AuthorityRecord } from "@/lib/authorities";

/**
 * PUBLIC REPORT TRACKING
 *
 * The page a WhatsApp citizen lands on. They have no account and no session, so
 * this is the one page in the app that renders without one.
 *
 * Read through the service-role client on purpose: every RLS policy in this
 * project is granted `to authenticated`, so the anon key reads zero rows. The
 * authorisation here is the token itself — a uuid, unguessable, unlike the
 * sequential report ids — and the query is scoped to exactly that token, never
 * to anything else supplied in the URL.
 *
 * One action, and only one: submitting an after-photo that closes the report
 * (TrackVerify -> /api/track/verify). It is here because without it a citizen
 * who filed over WhatsApp could watch their report forever and never finish it
 * — closure needs an account, and theirs belongs to the shared intake user.
 * Escalating, commenting and backing a case still require the app.
 *
 * The token is what authorises that action, and a token is a bearer credential,
 * not an identity — so it is never sufficient on its own: the server closes
 * only when the vision check independently agrees the photo shows the same
 * place with the defect gone. See the route for why that is stricter than the
 * in-app path.
 */

export const runtime = "nodejs";
// A status can change at any time (SLA sweeps, authority replies), and a stale
// tracking page is worse than a slow one.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Track your report — CivicAgent",
  robots: { index: false, follow: false },
};

function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  });
}

/**
 * Request-time data, including "now".
 *
 * `now` is resolved here rather than in the component body because it is part
 * of what this request observed, not something derived during render — and
 * reading the clock while rendering is exactly what the purity lint forbids.
 */
async function load(token: string) {
  // Reject anything that isn't a uuid before touching the database — the column
  // is uuid-typed, so a malformed value is an error rather than an empty result.
  if (!/^[0-9a-f-]{36}$/i.test(token)) return null;
  if (!adminConfigured()) return null;

  const report = await fetchReportByToken(createAdminClient(), token);
  if (!report) return null;
  return { report, now: Date.now() };
}

export default async function TrackPage({
  params,
}: {
  // params is a Promise in Next 16.
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const data = await load(token);
  if (!data) notFound();

  const { report, now } = data;
  const style = STATUS_STYLES[report.status];
  const authorities = (report.routing.authorities ?? []) as AuthorityRecord[];
  const overdue = now > report.slaDeadline && report.status !== "verified_fixed";

  return (
    <div className="scroll-thin h-full overflow-y-auto bg-[var(--bg)] px-4 py-6">
      <div className="mx-auto w-full max-w-lg">
        <header className="mb-5 flex items-center gap-2.5">
          <span
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-white"
            style={{ background: "var(--brand-grad)" }}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </span>
          <div>
            <p className="text-[15px] font-bold leading-tight tracking-tight">CivicAgent</p>
            <p className="text-[11px] text-[var(--text-dim)]">Public report tracking</p>
          </div>
        </header>

        <div className="card overflow-hidden rounded-2xl border border-[var(--border)]">
          {/* The bucket is public-read, so the photo needs no signed URL. */}
          {report.photoUrl && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={report.photoUrl}
              alt="Reported problem"
              className="max-h-[42vh] w-full object-cover"
            />
          )}

          <div className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-faint)]">
                  {report.id}
                </p>
                <h1 className="mt-0.5 truncate text-[19px] font-bold leading-tight">
                  {categoryLabel(report.category)}
                </h1>
                <p className="mt-0.5 text-[12px] text-[var(--text-dim)]">
                  Severity {report.severity} · reported {formatWhen(report.createdAt)}
                </p>
              </div>
              <span
                className="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold text-white"
                style={{ background: style.color }}
              >
                {style.label}
              </span>
            </div>

            <p className="mt-2 text-[12px] leading-relaxed text-[var(--text-dim)]">
              {style.description}
            </p>

            <dl className="mt-4 space-y-2 border-t border-[var(--border)] pt-3 text-[12px]">
              <Row label="Location">{report.place}</Row>
              <Row label="Filed to">
                {authorities.length ? (
                  <span className="space-y-0.5">
                    {authorities.map((a) => (
                      <span key={a.id} className="block">
                        {a.name}
                        {!a.verified && (
                          <span className="ml-1 text-[var(--warning)]">[unverified contact]</span>
                        )}
                      </span>
                    ))}
                  </span>
                ) : (
                  report.filedTo.join(", ") || "—"
                )}
              </Row>
              <Row label="Deadline">
                <span className={overdue ? "text-[var(--danger)]" : undefined}>
                  {formatWhen(report.slaDeadline)}
                  {overdue && " · past deadline"}
                </span>
              </Row>
              {report.routing.method && (
                <Row label="Routing">
                  <span className="text-[var(--text-dim)]">{report.routing.method}</span>
                </Row>
              )}
            </dl>

            {report.timeline.length > 0 && (
              <div className="mt-4 border-t border-[var(--border)] pt-3">
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-faint)]">
                  History
                </p>
                <ol className="space-y-2">
                  {report.timeline.map((event, i) => (
                    <li key={i} className="flex gap-2.5 text-[12px]">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
                      <span className="min-w-0">
                        <span className="block font-medium">{event.detail}</span>
                        <span className="block text-[10px] text-[var(--text-faint)]">
                          {formatWhen(event.at)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        </div>

        {/* The whole point of the page for the person who filed it. Hidden once
            closed, because there is nothing left to verify. */}
        {report.status !== "verified_fixed" && <TrackVerify token={token} />}

        {report.status === "verified_fixed" && report.afterPhotoUrl && (
          <div className="card mt-3 overflow-hidden rounded-2xl border border-[var(--border)]">
            <p className="px-4 pt-3 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-faint)]">
              The verified after-photo
            </p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={report.afterPhotoUrl}
              alt="The repair, after verification"
              className="mt-2 max-h-[42vh] w-full object-cover"
            />
          </div>
        )}

        {/* Said plainly, because the app claims on-device redaction and this
            intake path cannot deliver it. */}
        {report.source === "whatsapp" && (
          <p className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-[11px] leading-relaxed text-[var(--text-dim)]">
            Submitted over WhatsApp. Location metadata was stripped from this photo on our
            server, but unlike a report filed in the app it was <strong>not</strong> redacted
            on the sender&apos;s device — faces in it were never automatically blurred.
          </p>
        )}

        <p className="mt-3 text-center text-[11px] leading-relaxed text-[var(--text-faint)]">
          Anyone with this link can view this report, and can close it — but only with an
          after-photo that passes a check showing the same place with the problem gone. An
          authority saying &ldquo;done&rdquo; is not enough on its own.
        </p>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-[74px] shrink-0 text-[var(--text-faint)]">{label}</dt>
      <dd className="min-w-0 flex-1 font-medium">{children}</dd>
    </div>
  );
}
