import type { Metadata } from "next";
import AuthShell from "@/components/AuthShell";
import AuthForm from "@/components/AuthForm";

export const metadata: Metadata = {
  title: "Sign in to NammaCity",
};

export default async function LoginPage({
  searchParams,
}: {
  // searchParams is a Promise in Next 16.
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;

  return (
    <AuthShell
      title="Sign in"
      subtitle="Your reports, your ledger. Only you can close a report you filed."
    >
      <AuthForm mode="login" next={next ?? "/"} initialError={error} />
    </AuthShell>
  );
}
