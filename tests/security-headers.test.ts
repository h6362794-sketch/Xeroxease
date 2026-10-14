// Regression tests for the security-header middleware.
//
// WHY THIS FILE EXISTS
// Next.js only loads `middleware.ts` when it sits as a SIBLING of the `app/`
// directory. This project uses `src/app`, so the middleware must live at
// `src/middleware.ts`. It was previously committed at the repository root, where
// Next.js silently ignored it — every security header (CSP, HSTS, X-Frame-Options,
// Referrer-Policy, Permissions-Policy, X-Content-Type-Options) was missing from
// every response, and nothing failed or warned. There was no error to notice.
//
// The first block below fails if the file is ever moved back to the root.

import { describe, it, expect, vi } from "vitest";
import { existsSync } from "fs";
import { join } from "path";

const repoRoot = process.cwd();

describe("middleware file location", () => {
  it("lives at src/middleware.ts so Next.js actually loads it", () => {
    expect(existsSync(join(repoRoot, "src/middleware.ts"))).toBe(true);
  });

  it("is NOT at the repo root, where Next.js ignores it", () => {
    // A root middleware.ts alongside src/app is silently skipped.
    expect(existsSync(join(repoRoot, "middleware.ts"))).toBe(false);
  });

  it("the app directory really is src/app (justifies the above)", () => {
    expect(existsSync(join(repoRoot, "src/app"))).toBe(true);
    expect(existsSync(join(repoRoot, "app"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("security headers are actually set", () => {
  // The middleware reads NODE_ENV at call time, so it can be flipped per test.
  const originalNodeEnv = process.env.NODE_ENV;

  async function runMiddleware(nodeEnv: string, extraEnv: Record<string, string> = {}) {
    // NODE_ENV is declared readonly in the Next.js/Node typings, so write through
    // a plain record to vary it per test.
    const env = process.env as Record<string, string | undefined>;
    env.NODE_ENV = nodeEnv;
    for (const [k, v] of Object.entries(extraEnv)) env[k] = v;
    try {
      vi.resetModules();
      const { NextRequest } = await import("next/server");
      const mod = await import("@/middleware");
      const req = new NextRequest(new Request("https://xeroxease.example/login"));
      return mod.middleware(req);
    } finally {
      env.NODE_ENV = originalNodeEnv;
      for (const k of Object.keys(extraEnv)) delete env[k];
    }
  }

  it("sets the baseline headers in production", async () => {
    const res = await runMiddleware("production");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("content-security-policy")).toContain("object-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("permissions-policy")).toContain("camera=()");
    expect(res.headers.get("x-dns-prefetch-control")).toBe("off");
  });

  it("sets HSTS in production only", async () => {
    const prod = await runMiddleware("production");
    expect(prod.headers.get("strict-transport-security")).toBe(
      "max-age=63072000; includeSubDomains; preload"
    );

    const dev = await runMiddleware("development");
    expect(dev.headers.get("strict-transport-security")).toBeNull();
  });

  it("never enables 'unsafe-eval' or ws: outside development", async () => {
    const prod = await runMiddleware("production");
    const csp = prod.headers.get("content-security-policy") ?? "";
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("ws:");
    // ...but development needs them for HMR.
    const dev = await runMiddleware("development");
    expect(dev.headers.get("content-security-policy")).toContain("unsafe-eval");
  });

  it("allows frame embedding in development only when explicitly opted in", async () => {
    const devDefault = await runMiddleware("development");
    expect(devDefault.headers.get("x-frame-options")).toBe("DENY");

    const devOptIn = await runMiddleware("development", { ALLOW_DEV_FRAME_EMBED: "true" });
    expect(devOptIn.headers.get("x-frame-options")).toBeNull();
    expect(devOptIn.headers.get("content-security-policy")).not.toContain("frame-ancestors");

    // The opt-in must never leak into production.
    const prodOptIn = await runMiddleware("production", { ALLOW_DEV_FRAME_EMBED: "true" });
    expect(prodOptIn.headers.get("x-frame-options")).toBe("DENY");
    expect(prodOptIn.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
});
