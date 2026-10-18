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
    // The field name, the column name, or the index name all identify the reference index.
    expect(isPaymentReferenceConflict({ code: "P2002", meta: { target: "orders_payment_ref_key" } })).toBe(true);
    expect(isPaymentReferenceConflict({ code: "P2002", meta: { target: ["paymentRef"] } })).toBe(true);
    // A missing target must not be read as a payment-reference conflict.
    expect(isPaymentReferenceConflict({ code: "P2002", meta: {} })).toBe(false);
    expect(isPaymentReferenceConflict(new Error("boom"))).toBe(false);
  });
});

/**
 * Finding 6 boundary tests. They pin the current normalisation rules so a change is deliberate.
 * No legacy payment evidence is normalised by these tests: normalisation applies to new
 * submissions only. See docs/payment-reference-collision-plan.md before changing either.
 */
describe("payment reference boundaries", () => {
  it("is idempotent, so a normalised value normalises to itself", () => {
    for (const raw of ["utr 9876 5432", "  ab/cd.12-3_4 ", "UTR1234"]) {
      const once = normalizePaymentReference(raw);
      expect(normalizePaymentReference(once)).toBe(once);
    }
  });

  it("keeps separators significant: UTR-1234 and UTR1234 are different references", () => {
    expect(normalizePaymentReference("UTR-1234")).not.toBe(normalizePaymentReference("UTR1234"));
  });

  it("accepts a reference only after normalisation, and only in the allowed alphabet", () => {
    expect(isValidPaymentReference(normalizePaymentReference("utr 1234"))).toBe(true);
    expect(isValidPaymentReference(normalizePaymentReference("UTR<1234>"))).toBe(false);
    expect(isValidPaymentReference(normalizePaymentReference("UTR;DROP"))).toBe(false);
  });

  it("applies the 4-character minimum to the trimmed input, as the schema does", async () => {
    const { paymentSubmitSchema } = await import("@/server/validation");
    expect(paymentSubmitSchema.safeParse({ reference: "  ab " }).success).toBe(false);
    expect(paymentSubmitSchema.safeParse({ reference: " ab cd " }).success).toBe(true);
    expect(paymentSubmitSchema.safeParse({ reference: " ab cd " }).data?.reference).toBe("ABCD");
  });
});
