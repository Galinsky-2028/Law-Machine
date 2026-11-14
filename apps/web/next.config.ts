import type { NextConfig } from 'next';

/**
 * Security headers for every page and API response. Next.js needs inline
 * bootstrap scripts, so script-src keeps 'unsafe-inline' but nothing else
 * external: no third-party scripts, frames, or connections are allowed.
 */
const csp = [
  "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'",
  "connect-src 'self'", "worker-src 'self' blob:", "frame-ancestors 'none'", "form-action 'self'", "base-uri 'self'", "object-src 'none'"
].join('; ');
const security = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  ...(process.env.NODE_ENV === 'production' && (process.env.LM_ORIGIN ?? '').startsWith('https://') ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }] : [])
];
const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [
      { source: '/:path*', headers: security },
      { source: '/author/:path*', headers: [{ key: 'Cache-Control', value: 'no-store, private' }, { key: 'X-Robots-Tag', value: 'noindex, nofollow' }] }
    ];
  }
};
export default config;
