import { describe, it, expect } from "vitest";
import { calculatePrice, computeSheets, pricingKey } from "@/server/pricing";

const TABLE = { A4_BW: 2, A4_COLOR: 8, LEGAL_BW: 3, LEGAL_COLOR: 10, STAPLE: 5, SPIRAL: 40, STICK_FILE: 25 };

describe("computeSheets", () => {
  it("single side uses one sheet per page", () => {
    expect(computeSheets(10, "SINGLE")).toBe(10);
  });
  it("double side halves sheets with ceiling", () => {
    expect(computeSheets(10, "DOUBLE")).toBe(5);
    expect(computeSheets(11, "DOUBLE")).toBe(6);
    expect(computeSheets(1, "DOUBLE")).toBe(1);
  });
  it("handles zero/invalid", () => {
    expect(computeSheets(0, "SINGLE")).toBe(0);
  });
});

describe("pricingKey", () => {
  it("maps paper+colour to table key", () => {
    expect(pricingKey("A4", "BW")).toBe("A4_BW");
    expect(pricingKey("A4", "COLOR")).toBe("A4_COLOR");
    expect(pricingKey("LEGAL", "BW")).toBe("LEGAL_BW");
  });
});

describe("calculatePrice", () => {
  it("computes simple A4 B&W single-side order", () => {
    const r = calculatePrice(
      { paperSize: "A4", colorMode: "BW", sides: "SINGLE", copies: 1, totalPages: 10, finishing: [], pageSelection: "ALL" },
      TABLE
    );
    expect(r.billablePages).toBe(10);
    expect(r.printCost).toBe(20);
    expect(r.finishingFee).toBe(0);
    expect(r.total).toBe(20);
  });

  it("double-side halves billable pages", () => {
    const r = calculatePrice(
      { paperSize: "A4", colorMode: "BW", sides: "DOUBLE", copies: 1, totalPages: 41, finishing: [], pageSelection: "ALL" },
      TABLE
    );
    expect(r.billablePages).toBe(21); // ceil(41/2)
    expect(r.total).toBe(42);
  });

  it("multiplies by copies", () => {
    const r = calculatePrice(
      { paperSize: "A4", colorMode: "COLOR", sides: "SINGLE", copies: 3, totalPages: 8, finishing: [], pageSelection: "ALL" },
      TABLE
    );
    expect(r.billablePages).toBe(24);
    expect(r.total).toBe(192);
  });

  it("adds finishing fees", () => {
    const r = calculatePrice(
      { paperSize: "A4", colorMode: "BW", sides: "SINGLE", copies: 1, totalPages: 5, finishing: ["STAPLE", "SPIRAL"], pageSelection: "ALL" },
      TABLE
    );
    expect(r.finishingFee).toBe(45);
    expect(r.total).toBe(55);
  });

  it("rounds to 2 decimals", () => {
    const r = calculatePrice(
      { paperSize: "A4", colorMode: "BW", sides: "SINGLE", copies: 1, totalPages: 3, finishing: [], pageSelection: "ALL" },
      { A4_BW: 1.3333 }
    );
    expect(r.total).toBe(4); // 3.9999 -> 4
  });

  it("ignores unknown finishing keys (no crash)", () => {
    const r = calculatePrice(
      { paperSize: "A4", colorMode: "BW", sides: "SINGLE", copies: 1, totalPages: 5, finishing: ["UNKNOWN"], pageSelection: "ALL" },
      TABLE
    );
    expect(r.finishingFee).toBe(0);
  });

  it("missing price key prices at zero (server config error surfaced as 0, not crash)", () => {
    const r = calculatePrice(
      { paperSize: "A4", colorMode: "BW", sides: "SINGLE", copies: 1, totalPages: 5, finishing: [], pageSelection: "ALL" },
      {}
    );
    expect(r.total).toBe(0);
  });
});
