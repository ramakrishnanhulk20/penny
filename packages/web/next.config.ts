import type { NextConfig } from "next";
import { createMDX } from "fumadocs-mdx/next";

// Read when the headers are built, which is build time on Vercel, so each deployment carries one fixed policy.
function contentSecurityPolicy(): string {
  // Vercel's preview toolbar, with exactly the sources its docs list under "Using a Content Security Policy"
  // (vercel.com/docs/vercel-toolbar/managing-toolbar): https://vercel.live in script, style, image, font, connect
  // and frame sources; wss://ws-us3.pusher.com in connect; https://vercel.com and blob: in image; and
  // https://assets.vercel.com in font. Production never gets any of them.
  const preview = process.env.VERCEL_ENV === "preview";
  const toolbar = (...sources: string[]): string[] => (preview ? sources : []);
  // React's development build calls eval to rebuild server error stacks in the browser; its production build never does.
  const devEval = process.env.NODE_ENV === "development" ? ["'unsafe-eval'"] : [];
  // Without frame-src, frames fall back to default-src 'self', so the toolbar's frame is added to that.
  const frames: [string, string[]][] = preview ? [["frame-src", ["'self'", "https://vercel.live"]]] : [];
  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    // Next.js inlines its own bootstrap scripts, and nonces would force every prerendered page to render per request
    // (threat model C25, named there as a non-goal).
    ["script-src", ["'self'", "'unsafe-inline'", ...devEval, ...toolbar("https://vercel.live")]],
    ["style-src", ["'self'", "'unsafe-inline'", ...toolbar("https://vercel.live")]],
    ["img-src", ["'self'", "data:", ...toolbar("https://vercel.live", "https://vercel.com", "blob:")]],
    ["font-src", ["'self'", ...toolbar("https://vercel.live", "https://assets.vercel.com")]],
    ["connect-src", ["'self'", ...toolbar("https://vercel.live", "wss://ws-us3.pusher.com")]],
    ...frames,
    ["frame-ancestors", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["form-action", ["'self'"]],
    ["object-src", ["'none'"]],
  ];
  return directives.map(([name, sources]) => [name, ...sources].join(" ")).join("; ");
}

const groupPages = [{ key: "X-Robots-Tag", value: "noindex, nofollow" }];

const nextConfig: NextConfig = {
  // A verification build sets this so it never writes into the .next a running dev server is using.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  cacheComponents: true,
  partialPrefetching: true,
  transpilePackages: ["@penny/core"],
  async headers() {
    const everyRoute = [
      // The group link lives in the URL fragment; no-referrer stops any page URL leaking to another site.
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Content-Security-Policy", value: contentSecurityPolicy() },
      { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    ];
    return [
      { source: "/:path*", headers: everyRoute },
      { source: "/g", headers: groupPages },
      { source: "/g/:path*", headers: groupPages },
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

const withMDX = createMDX();

export default withMDX(nextConfig);
