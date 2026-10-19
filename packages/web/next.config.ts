import type { NextConfig } from "next";

const everyRoute = [
  // The group link lives in the URL fragment; no-referrer stops any page URL leaking to another site.
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const groupPages = [{ key: "X-Robots-Tag", value: "noindex, nofollow" }];

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  transpilePackages: ["@penny/core"],
  async headers() {
    return [
      { source: "/:path*", headers: everyRoute },
      { source: "/g", headers: groupPages },
      { source: "/g/:path*", headers: groupPages },
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

export default nextConfig;
