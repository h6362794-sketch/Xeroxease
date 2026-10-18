import { describe, it, expect, vi, beforeEach } from "vitest";

/** GET /api/orders/:id — a student must not see desk-only fields. */

const ORDER_ID = "55555555-5555-4555-8555-555555555555";
let role: "STUDENT" | "ADMIN" = "STUDENT";
let row: Record<string, unknown>;

vi.mock("@/lib/prisma", () => ({
  prisma: { order: { findUnique: vi.fn(async () => row) } },
}));
vi.mock("@/server/auth", () => ({
  requireUser: vi.fn(async () => ({ id: "student-1", role })),
  isAdminRole: (r: string) => r === "ADMIN" || r === "SUPER_ADMIN",
}));

beforeEach(() => {
  role = "STUDENT";
  row = {
    id: ORDER_ID,
    userId: "student-1",
    orderNumber: "XE-2026-000009",
    totalAmount: { toString: () => "90" },
    pricePerPage: { toString: () => "1" },
    finishingFee: { toString: () => "0" },
    adminNotes: "Customer is a repeat offender - check ID",
    paymentVerifiedBy: "admin-42",
    cancelledBy: null,
    collectionTokenHash: "deadbeef",
    collectionTokenUsedAt: null,
    files: [],
    events: [{ id: "e1", type: "PAYMENT_VERIFIED", message: null, createdAt: new Date(), actorId: "admin-42", actorRole: "ADMIN" }],
    feedback: null,
    user: { name: "A", email: "a@x", regNo: "1", phone: "1", branch: "CS", section: "A", year: 1 },
  };
});

async function get() {
  const { GET } = await import("@/app/api/orders/[id]/route");
  const res = await GET(new Request(`http://localhost/api/orders/${ORDER_ID}`), {
    params: Promise.resolve({ id: ORDER_ID }),
  });
  return (await res.json()).order;
}

describe("GET /api/orders/[id] redaction", () => {
  it("hides admin notes, verifier, token digest and admin actor ids from the owning student", async () => {
    const o = await get();
    expect(o.adminNotes).toBeNull();
    expect(o.paymentVerifiedBy).toBeNull();
    expect(o.collectionTokenHash).toBeNull();
    expect(o.user).toBeUndefined();
    expect(o.events[0].actorId).toBeNull();
    expect(o.events[0].type).toBe("PAYMENT_VERIFIED");
  });

  it("keeps the full record for an admin", async () => {
    role = "ADMIN";
    const o = await get();
    expect(o.adminNotes).toBe("Customer is a repeat offender - check ID");
    expect(o.paymentVerifiedBy).toBe("admin-42");
    expect(o.events[0].actorId).toBe("admin-42");
  });
});
