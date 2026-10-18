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
    paymentNote: "Matched UTR in bank statement",
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
    expect(o.paymentNote).toBeNull();
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
    expect(o.paymentNote).toBe("Matched UTR in bank statement");
    expect(o.events[0].actorId).toBe("admin-42");
  });
});

/**
 * Internal desk notes must not reach the owning student. These tests search the whole serialised
 * response for the internal text, so a new field that copies a note is caught too.
 */
describe("internal admin notes are not visible to the student", () => {
  const INTERNAL = "INTERNAL-DESK-NOTE-do-not-show-91";

  async function getRaw(): Promise<string> {
    const { GET } = await import("@/app/api/orders/[id]/route");
    const res = await GET(new Request(`http://localhost/api/orders/${ORDER_ID}`), {
      params: Promise.resolve({ id: ORDER_ID }),
    });
    return JSON.stringify(await res.json());
  }

  it("replaces a desk status-change note with a generic line", async () => {
    row.events = [
      { id: "e1", type: "STATUS_CHANGE", message: `Refund approved. ${INTERNAL}`, createdAt: new Date(), actorId: "admin-42", actorRole: "ADMIN", fromStatus: "PRINTING", toStatus: "CANCELLED" },
    ];
    const body = await getRaw();
    expect(body).not.toContain(INTERNAL);
    const parsed = JSON.parse(body);
    expect(parsed.order.events[0].message).toBe("The print desk updated this order.");
    // The status change itself is still shown to the student.
    expect(parsed.order.events[0].toStatus).toBe("CANCELLED");
  });

  it("withholds a desk cancellation reason from the student", async () => {
    row.status = "CANCELLED";
    row.cancelledBy = "admin-42";
    row.cancelReason = `Desk cancelled. ${INTERNAL}`;
    const body = await getRaw();
    expect(body).not.toContain(INTERNAL);
    expect(JSON.parse(body).order.cancelReason).toBeNull();
  });

  it("keeps the student's own cancellation reason", async () => {
    row.status = "CANCELLED";
    row.cancelledBy = "student-1";
    row.cancelReason = "Ordered by mistake";
    const parsed = JSON.parse(await getRaw());
    expect(parsed.order.cancelReason).toBe("Ordered by mistake");
  });

  it("keeps the desk's payment-rejection reason visible while the payment is rejected", async () => {
    row.paymentStatus = "PAYMENT_REJECTED";
    row.paymentNote = "Reference not found in statement";
    row.events = [
      { id: "e2", type: "PAYMENT_REJECTED", message: "Reference not found in statement", createdAt: new Date(), actorId: "admin-42", actorRole: "ADMIN" },
    ];
    const parsed = JSON.parse(await getRaw());
    expect(parsed.order.rejectionReason).toBe("Reference not found in statement");
    expect(parsed.order.events[0].message).toBe("Reference not found in statement");
    expect(parsed.order.paymentNote).toBeNull();
  });

  it("never returns internal text anywhere in the student response", async () => {
    row.adminNotes = INTERNAL;
    row.paymentNote = INTERNAL;
    row.cancelledBy = "admin-42";
    row.cancelReason = INTERNAL;
    row.events = [
      { id: "e1", type: "STATUS_CHANGE", message: INTERNAL, createdAt: new Date(), actorId: "admin-42", actorRole: "ADMIN" },
    ];
    expect(await getRaw()).not.toContain(INTERNAL);
  });

  it("gives an admin the full note on the status-change event", async () => {
    role = "ADMIN";
    row.events = [
      { id: "e1", type: "STATUS_CHANGE", message: INTERNAL, createdAt: new Date(), actorId: "admin-42", actorRole: "ADMIN" },
    ];
    const parsed = JSON.parse(await getRaw());
    expect(parsed.order.events[0].message).toBe(INTERNAL);
  });
});
