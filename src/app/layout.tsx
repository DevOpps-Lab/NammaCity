import type { Metadata, Viewport } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import ServiceWorkerRegistrar from "@/components/ServiceWorkerRegistrar";
import { Toaster } from "sonner";
import "./globals.css";

// The CSS variable names stay `--font-geist-*` on purpose. `globals.css` maps
// them into Tailwind's theme (`--font-sans`, `--font-mono`) and both names are
// referenced elsewhere; renaming the variable would silently drop the font
// everywhere rather than fail loudly. Only the family behind them changes.
const displaySans = Archivo({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

// Every changing number in this product — SLA countdowns, complaint
// references, confidence percentages — is set in mono with tabular figures so
// it cannot reflow as it updates.
const dataMono = IBM_Plex_Mono({
  variable: "--font-geist-mono",
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "NammaCity — civic accountability ledger",
  description:
    "Report a civic defect once. Agents file it against every responsible agency, track it against the authority's own published deadline, and escalate publicly if it's missed. Only a citizen can close it.",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "NammaCity",
  },
  // iOS "Add to Home Screen" reads <link rel="apple-touch-icon">, NOT the web
  // manifest's icon list. Without this the home screen tile is a screenshot of
  // whatever page was open, which reads as broken next to real apps.
  icons: {
    apple: [{ url: "/icons/icon-192.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  // Matches --bg. A white bar above a near-black app reads as a rendering bug
  // on Android and in the installed PWA.
  themeColor: "#0d0e10",
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
    <html lang="en" className={`${displaySans.variable} ${dataMono.variable}`}>
      <body>
        <ServiceWorkerRegistrar />
        {/* Fixed, non-scrolling app root — panes scroll internally so the map
            never gets pushed out of the viewport. */}
        <div id="app-root">{children}</div>
        <Toaster position="bottom-right" richColors />
      </body>
    </html>
  );
}
