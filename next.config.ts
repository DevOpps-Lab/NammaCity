import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // There is a stray package-lock.json in the parent (home) directory, so
  // Turbopack inferred the workspace root as C:\Users\ARAVIND KUMAR S.
  // Pin it to this project, or file watching and module resolution get confused.
  turbopack: {
    root: path.resolve(__dirname),
  },

  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;
