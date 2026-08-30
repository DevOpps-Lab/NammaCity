"use client";

import { useEffect, useState } from "react";
import Icon from "./Icon";

export default function DemoOnboarding() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const seen = localStorage.getItem("civicagent_demo_seen");
    if (!seen) {
      setTimeout(() => setOpen(true), 0);
    }
  }, []);

  if (!open) return null;

  const handleClose = () => {
    localStorage.setItem("civicagent_demo_seen", "true");
    setOpen(false);
  };

  return (
    <>
      <div className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm" />
      <div className="fixed inset-0 z-[101] flex items-center justify-center p-4">
        <div className="fade-in slide-up w-full max-w-md overflow-hidden rounded-2xl bg-[var(--surface)] shadow-[0_20px_60px_rgba(0,0,0,0.5)]">
          <div className="relative border-b border-[var(--border)] px-6 py-5 text-center">
            <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-xl bg-[var(--brand-grad)] text-white shadow-lg">
              <Icon name="shield" size={24} />
            </div>
            <h2 className="text-lg font-bold tracking-tight">Welcome to the NammaCity Demo</h2>
            <p className="mt-1 text-sm text-[var(--text-dim)]">
              This is a live, end-to-end sandbox.
            </p>
          </div>

          <div className="px-6 py-5 space-y-4 text-sm leading-relaxed text-[var(--text-dim)]">
            <div className="flex gap-3">
              <div className="mt-0.5 text-[var(--accent)]"><Icon name="clock" size={18} /></div>
              <div>
                <strong className="text-[var(--text)]">Fast-forward time.</strong> Turn on the Demo toggle (Top Right) to compress 1 hour into 1 second. Deadlines will breach live.
              </div>
            </div>
            <div className="flex gap-3">
              <div className="mt-0.5 text-[var(--warning)]"><Icon name="inbox" size={18} /></div>
              <div>
                <strong className="text-[var(--text)]">Real emails, sandboxed.</strong> Complaints are genuinely emailed via SMTP, but safely routed to our demo mailbox, not the government.
              </div>
            </div>
            <div className="flex gap-3">
              <div className="mt-0.5 text-[var(--success)]"><Icon name="camera" size={18} /></div>
              <div>
                <strong className="text-[var(--text)]">Community closure.</strong> A report closes only when a citizen (or authority) submits an after-photo that passes the AI vision check.
              </div>
            </div>
          </div>

          <div className="border-t border-[var(--border)] bg-[var(--surface-2)] p-4">
            <button
              onClick={handleClose}
              className="w-full rounded-xl bg-[var(--accent)] py-3 text-[13px] font-bold text-[var(--on-accent)] transition-colors hover:brightness-110"
            >
              Enter Sandbox
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
