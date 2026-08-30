import type { Metadata } from "next";
import AuthShell from "@/components/AuthShell";
import AuthForm from "@/components/AuthForm";

export const metadata: Metadata = {
  title: "Create a NammaCity account",
};

export default function SignupPage() {
  return (
    <AuthShell
      title="Create your account"
      subtitle="Your map starts seeded with a live Chennai caseload so there's something to work with immediately."
    >
      <AuthForm mode="signup" />
    </AuthShell>
  );
}
