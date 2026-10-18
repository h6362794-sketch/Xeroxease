// Cross-site request check for state-changing API calls. Edge-runtime safe (no Node APIs).
//
// The session cookie is SameSite=Lax, which already stops a cross-site POST from a modern
// browser. This is a second, explicit control: a browser always sends `Origin` on a
// cross-origin POST, so a state-changing request whose Origin is neither this site nor the
// configured public URL is refused. A missing Origin is allowed (non-browser clients carry
// no ambient cookies, and same-origin requests from older browsers may omit it). An Origin
// of "null" (sandboxed iframes, some redirects) is never trusted.

export const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface OriginContext {
  /** Host the request was addressed to, as seen by the app (`x-forwarded-host` first). */
  host: string | null;
  /** Scheme as seen by the client (`x-forwarded-proto` first). */
  proto: string | null;
  /** The configured public URL (`NEXT_PUBLIC_APP_URL`). */
  appUrl?: string | null;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function isTrustedRequestOrigin(origin: string | null, ctx: OriginContext): boolean {
  if (origin === null) return true;
  if (origin === "null") return false;
  if (ctx.host) {
    const proto = (ctx.proto ?? "https").split(",")[0].trim().toLowerCase();
    if (origin === `${proto}://${ctx.host}`) return true;
  }
  if (ctx.appUrl) {
    const configured = originOf(ctx.appUrl);
    if (configured && origin === configured) return true;
  }
  return false;
}

/** True when the request must be refused as a cross-site state change. */
export function isCrossSiteStateChange(method: string, pathname: string, origin: string | null, ctx: OriginContext): boolean {
  if (!pathname.startsWith("/api/")) return false;
  if (!UNSAFE_METHODS.has(method.toUpperCase())) return false;
  return !isTrustedRequestOrigin(origin, ctx);
}
