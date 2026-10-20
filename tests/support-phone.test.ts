// Public support/helpline configuration.
//
// The repository must never ship an invented phone number. When
// NEXT_PUBLIC_SUPPORT_PHONE is unset or malformed the UI falls back to plain
// text, so `supportTelHref` must return null instead of a broken `tel:` link.

import { readFileSync } from "fs";
import path from "path";
import { describe, it, expect } from "vitest";
import { normalizeSupportPhone, supportTelHref } from "@/lib/support";

describe("normalizeSupportPhone", () => {
  it("returns null when no number is configured", () => {
    expect(normalizeSupportPhone(undefined)).toBeNull();
    expect(normalizeSupportPhone(null)).toBeNull();
    expect(normalizeSupportPhone("")).toBeNull();
    expect(normalizeSupportPhone("   ")).toBeNull();
    expect(supportTelHref(undefined)).toBeNull();
    expect(supportTelHref("")).toBeNull();
  });

  it("normalizes common written forms to a dialable value", () => {
    expect(normalizeSupportPhone("+91 98765-43210")).toEqual({
      tel: "+919876543210",
      display: "+91 98765 43210",
    });
    expect(normalizeSupportPhone("(040) 1234 5678")).toEqual({
      tel: "04012345678",
      display: "04012345678",
    });
    expect(normalizeSupportPhone("98765 43210")).toEqual({
      tel: "9876543210",
      display: "98765 43210",
    });
  });

  it("rejects malformed, non-dialable and placeholder values", () => {
    const invalid = [
      "call us",
      "+91 (98765) 43210 ext 4",
      "<script>alert(1)</script>",
      "12345", // too short
      "+1234567890123456", // too long (E.164 max 15)
      "0000000",
      "0000000000",
      "1111111",
      "++919876543210",
    ];
    for (const raw of invalid) {
      expect(normalizeSupportPhone(raw)).toBeNull();
      expect(supportTelHref(raw)).toBeNull();
    }
  });

  it("produces only a tel: URI containing digits and a leading plus", () => {
    for (const raw of ["+91 98765 43210", "040-1234-5678", "9876543210"]) {
      const href = supportTelHref(raw);
      expect(href).toMatch(/^tel:\+?[0-9]+$/);
      expect(href).not.toMatch(/[<>&"'\s]/);
    }
  });
});

describe("environment documentation", () => {
  it("documents the public helpline variable with an empty (non-invented) default", () => {
    const example = readFileSync(path.join(process.cwd(), ".env.example"), "utf8");
    expect(example).toContain("NEXT_PUBLIC_SUPPORT_PHONE");
    expect(example).toMatch(/NEXT_PUBLIC_SUPPORT_PHONE\s*=\s*(""|'')/);
  });
});
