import { describe, it, expect } from "vitest";
import { calculatePrice, computeSheets, round2 } from "@/server/pricing";

/**
 * Pricing boundaries. The server is the only source of truth for money, so these
 * pin the arithmetic that a browser request cannot influence.
 */

const TABLE = {
  A4_BW: 2,
  A4_COLOR: 8,
  LEGAL_BW: 3,
  LEGAL_COLOR: 10,
  STAPLE: 5,
  SPIRAL: 40,
  STICK_FILE: 25,
};

const base = {
  paperSize: "A4" as const,
  colorMode: "BW" as const,
  sides: "SINGLE" as const,
  copies: 1,
  totalPages: 10,
  finishing: [] as string[],
  pageSelection: "ALL" as const,
};

describe("computeSheets", () => {
  it("uses one sheet per page for single-sided", () => {
    expect(computeSheets(10, "SINGLE")).toBe(10);
  });

  it("halves sheet usage for double-sided, rounding up", () => {
    expect(computeSheets(10, "DOUBLE")).toBe(5);
    expect(computeSheets(11, "DOUBLE")).toBe(6);
  });

  it("returns 0 for non-positive or non-finite counts (no negative pricing)", () => {
    expect(computeSheets(0, "SINGLE")).toBe(0);
    expect(computeSheets(-5, "SINGLE")).toBe(0);
    expect(computeSheets(Number.NaN, "SINGLE")).toBe(0);
    expect(computeSheets(Number.POSITIVE_INFINITY, "SINGLE")).toBe(0);
  });
});

describe("calculatePrice", () => {
  it("charges per billable page, not per source page", () => {
    const r = calculatePrice({ ...base, copies: 3 }, TABLE);
    expect(r.billablePages).toBe(30);
    expect(r.total).toBe(60);
  });

  it("applies double-side savings before multiplying by copies", () => {
    const r = calculatePrice({ ...base, sides: "DOUBLE", copies: 2, totalPages: 11 }, TABLE);
    // ceil(11/2)=6 sheets * 2 copies = 12 billable pages * 2 = 24
    expect(r.billablePages).toBe(12);
    expect(r.total).toBe(24);
  });

  it("adds finishing fees once per item, not per page", () => {
    const r = calculatePrice({ ...base, finishing: ["STAPLE", "SPIRAL"] }, TABLE);
    expect(r.finishingFee).toBe(45);
    expect(r.total).toBe(65);
  });

  it("ignores unknown finishing keys rather than throwing", () => {
    const r = calculatePrice({ ...base, finishing: ["NOT_A_THING" as never] }, TABLE);
    expect(r.finishingFee).toBe(0);
  });

  it("never lets copies drop below 1", () => {
    const r = calculatePrice({ ...base, copies: 0, totalPages: 4 }, TABLE);
    expect(r.billablePages).toBe(4);
  });

  it("floors non-integer copies", () => {
    const r = calculatePrice({ ...base, copies: 2.9, totalPages: 4 }, TABLE);
    expect(r.billablePages).toBe(8);
  });

  it("treats a missing or zero price as zero instead of NaN", () => {
    const r = calculatePrice(base, {});
    expect(Number.isFinite(r.total)).toBe(true);
    expect(r.total).toBe(0);
  });

  it("never returns a negative total", () => {
    const r = calculatePrice({ ...base, totalPages: -100, copies: -5 }, TABLE);
    expect(r.total).toBeGreaterThanOrEqual(0);
  });

  it("handles fractional unit prices without float drift", () => {
    const r = calculatePrice({ ...base, totalPages: 3 }, { A4_BW: 1.1 });
    expect(r.total).toBe(3.3);
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });

  it("supports the maximum configured copies and page counts", () => {
    const r = calculatePrice({ ...base, copies: 100, totalPages: 10000 }, TABLE);
    expect(r.billablePages).toBe(1_000_000);
    expect(r.total).toBe(2_000_000);
  });
});
