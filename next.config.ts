import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

/**
 * Content Security Policy (no nonces: pages stay cacheable; Next.js needs 'unsafe-inline' for its inline
 * bootstrap scripts without them). What the wallet flow needs:
 *  - Wallet extensions (Phantom, Solflare, Backpack…) register through the Wallet Standard from their own
 *    content scripts, which page CSP does not govern; their icons are data: URIs (img-src data:).
 *  - The Solana Mobile Wallet Adapter (Android browsers) talks to the wallet app over a local WebSocket
 *    (ws://localhost:<random port>), hence the localhost ws entries in connect-src.
 *  - The browser never talks to an RPC node: deposits are built and relayed by our own API ('self').
 * frame-ancestors 'none' + X-Frame-Options DENY stop clickjacking of the owner controls.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ws://localhost:* ws://127.0.0.1:*${isDev ? " ws: wss:" : ""}`,
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // strict-origin-when-cross-origin keeps same-origin Referer intact (the API's same-origin check can use it).
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  // Production is served over HTTPS (README "Deploying"); browsers ignore HSTS on plain-http dev hosts anyway.
  ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=31536000" }]),
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
