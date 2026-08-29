import type { MetadataRoute } from "next";

/**
 * Framework-native manifest (Next 16 built-in). Deliberately NOT next-pwa —
 * Turbopack is the default bundler in Next 16 and a webpack config causes
 * `next build` to fail, which rules out next-pwa and Serwist.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "NammaCity — civic issue accountability ledger",
    short_name: "NammaCity",
    description:
      "Report a civic defect once. Agents file it against every responsible agency, track it against the authority's own published SLA, and escalate publicly if it is missed. Only a citizen can close it.",
    start_url: "/",
    display: "standalone",
    // Both match --bg. These drive the installed app's splash screen and window
    // chrome, so leaving them white flashes a white card before a near-black app
    // on every cold launch.
    background_color: "#0d0e10",
    theme_color: "#0d0e10",
    orientation: "portrait",
    categories: ["utilities", "government"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
