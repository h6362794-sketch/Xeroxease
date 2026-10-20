// Execute the actual Server Component with mocked infrastructure, not a browser
// or live-DB test. Schema rejection must propagate, never become an empty state.
import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const db = vi.hoisted(() => ({
  findFirst: vi.fn(), findMany: vi.fn(), aggregate: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { order: db } }));
vi.mock("@/server/auth", () => ({ requirePageUser: async () => ({ id: "student-1", name: "Test Student" }) }));
vi.mock("@/server/recovery", () => ({ getRecoveryCodeStatus: async () => ({ hasCode: false, usedAt: null }) }));
import DashboardPage from "@/app/(student)/dashboard/page";
beforeEach(() => {
  db.findFirst.mockReset().mockResolvedValue(null);
  db.findMany.mockReset().mockResolvedValue([]);
  db.aggregate.mockReset().mockResolvedValue({ _count: 0, _sum: { totalAmount: null } });
});
it("renders legitimate no-order/null-spend states for the authenticated owner", async () => {
  const html = renderToStaticMarkup(await DashboardPage());
  expect(html).toContain("No active orders");
  expect(html).toContain("No orders yet.");
  expect(db.findMany.mock.calls[0][0].where).toEqual({ userId: "student-1" });
});
it("excludes canonical as well as legacy terminal orders from the active card", async () => {
  await DashboardPage();
  expect(db.findFirst.mock.calls[0][0].where.status.notIn).toEqual(expect.arrayContaining([
    "DELIVERED", "REJECTED", "COMPLETED", "CANCELLED", "FAILED",
  ]));
});
it("propagates the missing-column failure after authentication instead of concealing it", async () => {
  const error = Object.assign(new Error("column orders.pricing_snapshot does not exist"), { code: "P2022" });
  db.findFirst.mockRejectedValue(error);
  await expect(DashboardPage()).rejects.toBe(error);
});
it("renders an existing order and its Decimal-like total", async () => {
  const order = { id: "order-1", orderNumber: "XE-TEST", status: "ACCEPTED", paperSize: "A4", colorMode: "BW", totalPages: 2, copies: 1, totalAmount: { toString: () => "4" }, createdAt: new Date(), updatedAt: new Date() };
  db.findFirst.mockResolvedValue(order);
  db.findMany.mockResolvedValue([order]);
  const html = renderToStaticMarkup(await DashboardPage());
  expect(html).toContain("XE-TEST");
  expect(html).toMatch(/₹.*4/);
});
