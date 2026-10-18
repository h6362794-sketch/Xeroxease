import { describe, it, expect } from "vitest";
import { isCrossSiteStateChange, isTrustedRequestOrigin } from "@/lib/request-origin";

const ctx = { host: "xeroxease.example", proto: "https", appUrl: "https://xeroxease.example" };

describe("isTrustedRequestOrigin", () => {
  it("trusts the site's own origin", () => {
    expect(isTrustedRequestOrigin("https://xeroxease.example", ctx)).toBe(true);
  });
  it("refuses another site", () => {
    expect(isTrustedRequestOrigin("https://evil.example", ctx)).toBe(false);
    expect(isTrustedRequestOrigin("https://xeroxease.example.evil.example", ctx)).toBe(false);
  });
  it("refuses a scheme downgrade of the same host", () => {
    expect(isTrustedRequestOrigin("http://xeroxease.example", ctx)).toBe(false);
  });
  it("never trusts the opaque 'null' origin", () => {
    expect(isTrustedRequestOrigin("null", ctx)).toBe(false);
  });
  it("uses the forwarded host and proto behind a proxy", () => {
    const behindProxy = { host: "internal:3000", proto: "https, http", appUrl: null };
    expect(isTrustedRequestOrigin("https://internal:3000", behindProxy)).toBe(true);
    expect(isTrustedRequestOrigin("http://internal:3000", behindProxy)).toBe(false);
  });
  it("accepts the configured public URL even when the host header differs", () => {
    expect(isTrustedRequestOrigin("https://xeroxease.example", { host: "x.vercel.internal", proto: "https", appUrl: "https://xeroxease.example/" })).toBe(true);
  });
});

describe("isCrossSiteStateChange", () => {
  it("blocks a cross-site POST to the API", () => {
    expect(isCrossSiteStateChange("POST", "/api/orders", "https://evil.example", ctx)).toBe(true);
    expect(isCrossSiteStateChange("PATCH", "/api/admin/payments/x/verify", "https://evil.example", ctx)).toBe(true);
  });
  it("allows same-site and originless requests", () => {
    expect(isCrossSiteStateChange("POST", "/api/orders", "https://xeroxease.example", ctx)).toBe(false);
    expect(isCrossSiteStateChange("POST", "/api/auth/login", null, ctx)).toBe(false);
  });
  it("does not affect safe methods or non-API pages", () => {
    expect(isCrossSiteStateChange("GET", "/api/orders", "https://evil.example", ctx)).toBe(false);
    expect(isCrossSiteStateChange("POST", "/login", "https://evil.example", ctx)).toBe(false);
  });
});
