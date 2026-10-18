import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Security headers on every response. Route-level auth is enforced server-side
 * in layouts/API handlers (this middleware never trusts cookies for decisions).
 */

/**
 * Origin of the configured Supabase project, for CSP `connect-src`.
 *
 * The direct-upload protocol has the browser PUT document bytes straight to a
 * signed URL on this host (see `src/lib/direct-upload.ts`), so `connect-src`
 * must permit exactly this origin — nothing broader.
 *
 * Returns `null` (fail closed, origin simply omitted) unless the value is a
 * syntactically valid **https** URL with a plain DNS hostname. That rejects —
 * without weakening the policy — a missing setting, non-https schemes (the
 * browser would be downgraded to cleartext), wildcards, userinfo, IPv6
 * literals, and anything the URL parser cannot make sense of. The path portion
 * is irrelevant (`check-env.ts` requires the bare project URL) and is dropped:
 * only the origin is ever returned, so no path can leak into the header.
 */
export function supabaseStorageOrigin(
  rawUrl: string | undefined
): string | null {
  if (!rawUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  // Never derive a CSP source from a URL that carries credentials —
  // the origin is all we need, and such a value is a misconfiguration.
  if (parsed.username) return null;
  // Plain DNS labels only: letters, digits, hyphens, dots. This excludes
  // wildcards, IPv6 literals and any residual CSP-significant characters.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(parsed.hostname)) {
    return null;
  }
  return parsed.origin;
}

/**
 * The full Content-Security-Policy header value, derived from the environment.
 * Pure on purpose so tests can exercise CSP generation without HTTP.
 */
export function buildContentSecurityPolicy(
  env: Record<string, string | undefined>
): string {
  const isDev = env.NODE_ENV === "development";
  const storageOrigin = supabaseStorageOrigin(env.NEXT_PUBLIC_SUPABASE_URL);

  // Content Security Policy — built around actual app needs:
  // - 'unsafe-inline' styles: Tailwind-in-JS transitions + Next.js injected styles
  // - blob:/data: not needed for images; media from self (intro video)
  // - connect-src: the Supabase project origin is the direct-upload target the
  //   browser PUTs documents to; omitted entirely when not validly configured
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'" + (isDev ? " 'unsafe-eval'" : ""),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self'",
    "font-src 'self' data:",
    "connect-src 'self'" +
      (storageOrigin ? ` ${storageOrigin}` : "") +
      (isDev ? " ws: wss:" : ""),
    // Framing is denied in production. Development may opt in (embedded previews,
    // Storybook-style tooling) with ALLOW_DEV_FRAME_EMBED=true -- never set this in
    // a deployed environment.
    ...(isDev && env.ALLOW_DEV_FRAME_EMBED === "true"
      ? []
      : ["frame-ancestors 'none'"]),
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");

  return csp;
}

export function middleware(req: NextRequest) {
  const res = NextResponse.next();

  const csp = buildContentSecurityPolicy(process.env);

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
