// Focused tests for CSP `connect-src` generation (src/middleware.ts).
//
// WHY THIS FILE EXISTS
// The direct-upload protocol has the browser PUT document bytes straight to
// a signed URL on the Supabase project origin. A CSP whose connect-src only
// allows 'self' blocks that PUT in production — uploads fail with the generic
// "Could not reach the storage service" error. These tests pin the rule that
// the configured Supabase origin — and only that origin — is allowed, and
// that missing or malformed configuration can never widen the policy.

import { describe, it, expect, vi } from "vitest";
import {
  buildContentSecurityPolicy,
  supabaseStorageOrigin,
} from "@/middleware";

const SUPABASE_URL = "https://vjwvvoczyuebtowbnuqf.supabase.co";

/** Tokens of a single CSP directive, e.g. ["'self'", "https://…"] */
function directiveTokens(csp: string, name: string): string[] {
  const directive = csp
    .split("; ")
    .find((d) => d.startsWith(`${name} `) || d === name);
  if (!directive) return [];
  return directive.slice(name.length + 1).split(" ").filter(Boolean);
}

describe("supabaseStorageOrigin", () => {
  it("derives the origin from a valid https project URL", () => {
    expect(supabaseStorageOrigin(SUPABASE_URL)).toBe(SUPABASE_URL);
    // Trailing slash / path must not leak into the CSP source.
    expect(supabaseStorageOrigin(`${SUPABASE_URL}/`)).toBe(SUPABASE_URL);
    expect(supabaseStorageOrigin(`${SUPABASE_URL}/storage/v1`)).toBe(SUPABASE_URL);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["whitespace", "   "],
    ["not a URL", "not-a-url"],
    ["plain-http scheme (cleartext)", "http://vjwvvoczyuebtowbnuqf.supabase.co"],
    ["non-https scheme", "ftp://vjwvvoczyuebtowbnuqf.supabase.co"],
    ["scheme-only", "https://"],
    ["wildcard host", "https://*.supabase.co"],
    ["wildcard prefix", "https://*.example.com"],
    ["userinfo", "https://user:pass@evil.example.com"],
    ["ipv6 literal", "https://[::1]"],
    ["javascript scheme", "javascript:alert(1)"],
  ])("rejects %s (fail closed)", (_label, value) => {
    expect(supabaseStorageOrigin(value as string | undefined)).toBeNull();
  });
});

describe("buildContentSecurityPolicy — connect-src", () => {
  it("includes the configured Supabase origin in production", () => {
    const csp = buildContentSecurityPolicy({
      NODE_ENV: "production",
      NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
    });
    expect(directiveTokens(csp, "connect-src")).toEqual([
      "'self'",
      SUPABASE_URL,
    ]);
  });

  it("keeps the development WebSocket allowances alongside the origin", () => {
    const csp = buildContentSecurityPolicy({
      NODE_ENV: "development",
      NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
    });
    expect(directiveTokens(csp, "connect-src")).toEqual([
      "'self'",
      SUPABASE_URL,
      "ws:",
      "wss:",
    ]);
  });

  it("does not allow unrelated external origins", () => {
    const csp = buildContentSecurityPolicy({
      NODE_ENV: "production",
      NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
    });
    const connectSrc = directiveTokens(csp, "connect-src").join(" ");
    expect(connectSrc).not.toContain("evil.example.com");
    expect(connectSrc).not.toContain("other-project.supabase.co");
    expect(connectSrc).not.toContain("googleapis.com");
    // No wildcard escape hatch anywhere, and no scheme-wide `https:` source
    // (only the single, fully-specified origin is ever allowed).
    const allTokens = csp.split("; ").flatMap((d) => d.split(" "));
    expect(allTokens).not.toContain("*");
    expect(allTokens).not.toContain("https:");
    expect(allTokens).not.toContain("ws:");
  });

  it("omits the origin entirely when the setting is missing", () => {
    const csp = buildContentSecurityPolicy({ NODE_ENV: "production" });
    expect(directiveTokens(csp, "connect-src")).toEqual(["'self'"]);
  });

  it.each([
    ["malformed", "not-a-url"],
    ["plain-http (cleartext downgrade)", "http://vjwvvoczyuebtowbnuqf.supabase.co"],
    ["wildcard", "https://*.supabase.co"],
  ])("treats a %s value as unconfigured — no permissive rule is added", (_label, value) => {
    const csp = buildContentSecurityPolicy({
      NODE_ENV: "production",
      NEXT_PUBLIC_SUPABASE_URL: value,
    });
    // Fail closed: identical to the no-configuration policy, never wider.
    expect(directiveTokens(csp, "connect-src")).toEqual(["'self'"]);
    const allTokens = csp.split("; ").flatMap((d) => d.split(" "));
    expect(allTokens).not.toContain("*");
    expect(allTokens).not.toContain("https:");
  });
});

describe("buildContentSecurityPolicy — existing directives intact", () => {
  it("preserves every other directive in production", () => {
    const csp = buildContentSecurityPolicy({
      NODE_ENV: "production",
      NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
    });
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("media-src 'self'");
    expect(csp).toContain("font-src 'self' data:");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("object-src 'none'");
  });

  it("preserves development-only behavior (unsafe-eval, frame opt-in)", () => {
    const dev = buildContentSecurityPolicy({
      NODE_ENV: "development",
      NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
    });
    expect(dev).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
    // Without the explicit opt-in, framing stays denied in development too.
    expect(dev).toContain("frame-ancestors 'none'");

    const devOptIn = buildContentSecurityPolicy({
      NODE_ENV: "development",
      ALLOW_DEV_FRAME_EMBED: "true",
      NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
    });
    expect(devOptIn).not.toContain("frame-ancestors");

    // The opt-in must never leak into production.
    const prodOptIn = buildContentSecurityPolicy({
      NODE_ENV: "production",
      ALLOW_DEV_FRAME_EMBED: "true",
      NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
    });
    expect(prodOptIn).toContain("frame-ancestors 'none'");
  });
});

// ---------------------------------------------------------------------------
// End-to-end through the middleware, matching the pattern in
// tests/security-headers.test.ts (NODE_ENV is read at call time).
// ---------------------------------------------------------------------------

describe("middleware sets the CSP header with the storage origin", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  async function runMiddleware(extraEnv: Record<string, string | undefined>) {
    const env = process.env as Record<string, string | undefined>;
    env.NODE_ENV = "production";
    for (const [k, v] of Object.entries(extraEnv)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    try {
      vi.resetModules();
      const { NextRequest } = await import("next/server");
      const mod = await import("@/middleware");
      const req = new NextRequest(new Request("https://xeroxease.example/login"));
      return mod.middleware(req);
    } finally {
      env.NODE_ENV = originalNodeEnv;
      delete env.NEXT_PUBLIC_SUPABASE_URL;
    }
  }

  it("allows the configured Supabase origin in production", async () => {
    const res = await runMiddleware({ NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL });
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(directiveTokens(csp, "connect-src")).toEqual([
      "'self'",
      SUPABASE_URL,
    ]);
  });

  it("stays at 'self' only when the setting is absent", async () => {
    const res = await runMiddleware({});
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(directiveTokens(csp, "connect-src")).toEqual(["'self'"]);
  });
});
