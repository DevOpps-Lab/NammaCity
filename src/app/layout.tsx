import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import ServiceWorkerRegistrar from "@/components/ServiceWorkerRegistrar";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "CivicAgent — civic accountability ledger",
  description:
    "Report a civic defect once. Agents file it against every responsible agency, track it against the authority's own published deadline, and escalate publicly if it's missed. Only a citizen can close it.",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "CivicAgent",
  },
  // iOS "Add to Home Screen" reads <link rel="apple-touch-icon">, NOT the web
  // manifest's icon list. Without this the home screen tile is a screenshot of
  // whatever page was open, which reads as broken next to real apps.
  icons: {
    apple: [{ url: "/icons/icon-192.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
  width: "device-width",
  initialScale: 1,
  // Never disable zoom — maximumScale/user-scalable lockouts fail WCAG.
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>
        <ServiceWorkerRegistrar />
        {/* Fixed, non-scrolling app root — panes scroll internally so the map
            never gets pushed out of the viewport. */}
        <div id="app-root">{children}</div>
      </body>
    </html>
  );
}
