import type { MetadataRoute } from "next";

/**
 * Framework-native manifest (Next 16 built-in). Deliberately NOT next-pwa —
 * Turbopack is the default bundler in Next 16 and a webpack config causes
 * `next build` to fail, which rules out next-pwa and Serwist.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "CivicAgent — civic issue accountability ledger",
    short_name: "CivicAgent",
    description:
      "Report a civic defect once. Agents file it against every responsible agency, track it against the authority's own published SLA, and escalate publicly if it is missed. Only a citizen can close it.",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    orientation: "portrait",
    categories: ["utilities", "government"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
