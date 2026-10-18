import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isCrossSiteStateChange } from "@/lib/request-origin";

/**
 * Security headers on every response. Route-level auth is enforced server-side
 * in layouts/API handlers (this middleware never trusts cookies for decisions).
 */
export function middleware(req: NextRequest) {
  // Refuse cross-site state changes to the API before any handler runs. SameSite=Lax
  // already blocks the common case; this makes the rule explicit and independent of it.
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(/:$/, "");
  if (
    isCrossSiteStateChange(req.method, req.nextUrl.pathname, req.headers.get("origin"), {
      host: req.headers.get("x-forwarded-host") ?? req.headers.get("host"),
      proto,
      appUrl: process.env.NEXT_PUBLIC_APP_URL,
    })
  ) {
    return NextResponse.json(
      { error: "This request was refused because it came from another site.", code: "CROSS_SITE_REFUSED" },
      { status: 403, headers: { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" } }
    );
  }

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
    // Framing is denied in production. Development may opt in (embedded previews,
    // Storybook-style tooling) with ALLOW_DEV_FRAME_EMBED=true -- never set this in
    // a deployed environment.
    ...(process.env.NODE_ENV === "development" && process.env.ALLOW_DEV_FRAME_EMBED === "true"
      ? []
      : ["frame-ancestors 'none'"]),
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");

  res.headers.set("Content-Security-Policy", csp);
  res.headers.set("X-Content-Type-Options", "nosniff");
  if (!(process.env.NODE_ENV === "development" && process.env.ALLOW_DEV_FRAME_EMBED === "true")) {
    res.headers.set("X-Frame-Options", "DENY");
  }
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
