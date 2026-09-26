import { describe, it, expect } from "vitest";
import { parsePageSelection, countSelectedPages } from "@/server/page-selection";

describe("parsePageSelection", () => {
  it("ALL returns full range", () => {
    const r = parsePageSelection("ALL", 5);
    expect(r.pages).toEqual([1, 2, 3, 4, 5]);
    expect(r.error).toBeUndefined();
  });

  it("parses simple list", () => {
    const r = parsePageSelection("1, 3, 5", 10);
    expect(r.pages).toEqual([1, 3, 5]);
  });

  it("parses ranges", () => {
    const r = parsePageSelection("1-5, 8, 10-15", 20);
    expect(r.pages).toEqual([1, 2, 3, 4, 5, 8, 10, 11, 12, 13, 14, 15]);
  });

  it("deduplicates overlapping ranges", () => {
    const r = parsePageSelection("1-5, 3-7", 10);
    expect(r.pages).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("rejects pages beyond total", () => {
    const r = parsePageSelection("1-5, 12", 10);
    expect(r.error).toContain("exceeds");
  });

  it("rejects reversed ranges", () => {
    const r = parsePageSelection("5-2", 10);
    expect(r.error).toBeDefined();
  });

  it("rejects garbage", () => {
    const r = parsePageSelection("1; DROP TABLE users", 10);
    expect(r.error).toBeDefined();
  });

  it("rejects empty selection", () => {
    const r = parsePageSelection("  ", 10);
    expect(r.pages.length).toBe(10); // blank = ALL
  });

  it("countSelectedPages helper", () => {
    expect(countSelectedPages("1-5, 8", 20)).toBe(6);
    expect(countSelectedPages("ALL", 7)).toBe(7);
  });
});
