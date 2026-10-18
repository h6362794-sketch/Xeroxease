import { describe, it, expect } from "vitest";
import {
  normalizePaymentReference,
  isValidPaymentReference,
  isPaymentReferenceConflict,
} from "@/server/payment-reference";

describe("normalizePaymentReference", () => {
  it("treats case and whitespace variants as the same reference", () => {
    expect(normalizePaymentReference(" utr 1234 5678 ")).toBe("UTR12345678");
    expect(normalizePaymentReference("UTR12345678")).toBe("UTR12345678");
  });
});

describe("isValidPaymentReference", () => {
  it("accepts typical bank/UPI reference shapes", () => {
    for (const ok of ["123456789012", "UPI-REF_1/2.3", "ABCD"]) {
      expect(isValidPaymentReference(normalizePaymentReference(ok))).toBe(true);
    }
  });
  it("rejects too-short, too-long and unexpected characters", () => {
    expect(isValidPaymentReference("ABC")).toBe(false);
    expect(isValidPaymentReference("A".repeat(65))).toBe(false);
    expect(isValidPaymentReference("<SCRIPT>")).toBe(false);
    expect(isValidPaymentReference("AB CD;DROP")).toBe(false);
  });
});

describe("isPaymentReferenceConflict", () => {
  it("recognises a unique violation on payment_ref only", () => {
    expect(isPaymentReferenceConflict({ code: "P2002", meta: { target: ["payment_ref"] } })).toBe(true);
    expect(isPaymentReferenceConflict({ code: "P2002", meta: { target: ["order_number"] } })).toBe(false);
    expect(isPaymentReferenceConflict(new Error("boom"))).toBe(false);
  });
});
