import type { NextConfig } from "next";
import { execSync } from "node:child_process";

/**
 * Short git SHA of the current commit — baked into the client bundle as
 * NEXT_PUBLIC_BUILD_ID and shown in the app footer, so anyone can verify
 * at a glance WHICH build the browser is running (the definitive answer to
 * "am I seeing the latest version or a stale cached one?").
 */
function gitShortSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: process.cwd() })
      .toString()
      .trim();
  } catch {
    return "local";
  }
}

const nextConfig: NextConfig = {
  // Required by the deployment pipeline (.zscripts/build.sh): `next build`
  // must emit .next/standalone/server.js, which start.sh runs in production.
  output: "standalone",
  // Coding standard: type errors must never be silently ignored.
  // `tsc --noEmit` (0 errors) gates every change; the build re-checks it.
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: false,
  // The preview platform's edge proxy 301-redirects `/x` -> `/x/` (permanent),
  // while Next's built-in trailing-slash handling 308-redirects `/x/` -> `/x`
  // (also permanent). Together they form an infinite cached redirect loop
  // (ERR_TOO_MANY_REDIRECTS) for every page behind that proxy. Serving both
  // forms directly with 200 makes the loop impossible.
  skipTrailingSlashRedirect: true,
  // Version stamp visible in the UI (footer) — see gitShortSha() above.
  env: {
    NEXT_PUBLIC_BUILD_ID: gitShortSha(),
  },
  // CACHE-FRESHNESS POLICY (the "cache must be cleared properly" guarantee):
  //   - Pages + APIs are served `no-store, must-revalidate`, so every refresh
  //     fetches the CURRENT deployment — a stale shell can never survive a
  //     rebuild in the browser or in the preview platform's edge cache.
  //     (APIs additionally set the same header response-by-response in
  //     src/lib/api.ts; page routes get it from src/proxy.ts as well.)
  //   - /_next/static assets are content-HASHED by filename, so they are safe
  //     to cache forever — the hash changes exactly when the content does.
  //     Keeping them immutable keeps the app fast without staleness risk.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, must-revalidate" },
          // SECURITY HEADERS (audit 2026-10-09 — none were set before).
          // CSP is deliberately pragmatic: 'unsafe-inline' script/style stays
          // (Next.js bootstrap + styled JSX), but injection-prone sinks are
          // closed (object/frame-ancestors/base-uri/form-action) and content
          // is restricted to self + https media + websocket connect.
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'self'; " +
              "script-src 'self' 'unsafe-inline'; " +
              "style-src 'self' 'unsafe-inline'; " +
              "img-src 'self' data: blob: https: http:; " +
              "font-src 'self' data:; " +
              "connect-src 'self' ws: wss:; " +
              "media-src 'self' https:; " +
              "object-src 'none'; " +
              "base-uri 'self'; " +
              "form-action 'self'; " +
              "frame-ancestors 'none'",
          },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
          { key: "X-DNS-Prefetch-Control", value: "off" },
          // Behind the TLS-terminating preview gateway this is always honest;
          // over plain HTTP (localhost) browsers simply ignore HSTS.
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        ],
      },
      {
        source: "/_next/static/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
