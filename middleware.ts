import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Security headers on every response. Route-level auth is enforced server-side
 * in layouts/API handlers (this middleware never trusts cookies for decisions).
 */
export function middleware(req: NextRequest) {
  const res = NextResponse.next();

  // Content Security Policy — built around actual app needs:
  // - 'unsafe-inline' styles: Tailwind-in-JS transitions + Next.js injected styles
  // - blob:/data: not needed for images; media from self (intro video)
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'" + (process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self'",
    "font-src 'self' data:",
    "connect-src 'self'" + (process.env.NODE_ENV === "development" ? " ws: wss:" : ""),
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");

  res.headers.set("Content-Security-Policy", csp);
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.headers.set("X-DNS-Prefetch-Control", "off");
  if (process.env.NODE_ENV === "production") {
    res.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }

  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|brand/|favicon.ico).*)"],
};
