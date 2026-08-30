import type { Metadata } from "next";
import Link from "next/link";
import { isGovUser } from "@/lib/admin-auth";
import AdminConsole from "@/components/admin/AdminConsole";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "City console",
  // Same reason /track carries it: this page is addressed, not discovered.
  robots: { index: false, follow: false },
};

/**
 * The government console.
 *
 * Anonymous visitors never arrive: /admin is absent from PUBLIC_PATHS in
 * proxy.ts, so they are redirected to /login before this renders. What the
 * proxy cannot do is tell one signed-in account from another, which is what the
 * check below is for, and what civic_is_gov() enforces again in Postgres for
 * every number on the page.
 */
export default async function AdminPage() {
  if (!(await isGovUser())) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6">
        <div className="measure text-center">
          <h1 className="t-title">Not available on this account</h1>
          <p className="t-sm mt-2 text-[var(--text-dim)]">
            The city console is limited to accounts a city administrator has granted access to.
            Your own reports are unaffected.
          </p>
          <Link href="/" className="btn btn-outline mt-5">
            Back to the app
          </Link>
        </div>
      </div>
    );
  }

  return <AdminConsole />;
}
