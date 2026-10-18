import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Finding 5: re-analysis must never replace a verified, ordered or purged page count.
 * The route claims the row conditionally before analysing, and writes the result only while the
 * row is still its claim. Analysis failure puts the row back so the student can retry.
 */

const OWNER = "11111111-1111-4111-8111-111111111111";
const FILE_ID = "22222222-2222-4222-8222-222222222222";

const m = vi.hoisted(() => ({
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  analyzeDocument: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    uploadedFile: {
      findFirst: (...a: unknown[]) => m.findFirst(...a),
      updateMany: (...a: unknown[]) => m.updateMany(...a),
    },
  },
}));
vi.mock("@/server/auth", () => ({
  requireUser: async () => ({ id: OWNER, role: "STUDENT" }),
}));
vi.mock("@/server/rate-limit", () => ({
  RATE_LIMITS: { analyze: { limit: 1000, windowMs: 60_000 } },
  rateLimitAsync: async () => ({ ok: true, retryAfterSec: 0 }),
}));
vi.mock("@/server/doc-analysis", () => ({
  analyzeDocument: (...a: unknown[]) => m.analyzeDocument(...a),
}));

const ROW = {
  id: FILE_ID,
  uploaderId: OWNER,
  originalName: "notes.pdf",
  storageKey: `${OWNER}/key-notes.pdf`,
  analysisStatus: "PENDING",
  pageCount: null,
  orderId: null,
  purgedAt: null,
};

function req(): Request {
  return new Request("http://localhost/api/documents/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fileId: FILE_ID }),
  });
}

async function call() {
  const route = await import("@/app/api/documents/analyze/route");
  return route.POST(req());
}

beforeEach(() => {
  m.findFirst.mockReset().mockResolvedValue({ ...ROW });
  m.updateMany.mockReset().mockResolvedValue({ count: 1 });
  m.analyzeDocument.mockReset().mockResolvedValue({ pageCount: 12, source: "DOCUMENT_PARSER", status: "COMPLETED", error: null });
});

describe("POST /api/documents/analyze", () => {
  it.each([
    ["a verified (COMPLETED) count", { analysisStatus: "COMPLETED", pageCount: 40, pageCountSource: "DOCUMENT_PARSER" }],
    ["a desk-verified count", { analysisStatus: "COMPLETED", pageCount: 40, pageCountSource: "ADMIN_VERIFIED" }],
    ["a student-confirmed count", { analysisStatus: "COMPLETED", pageCount: 40, pageCountSource: "USER_CONFIRMED" }],
  ])("refuses to re-analyse %s without touching the row", async (_label, extra) => {
    m.findFirst.mockResolvedValue({ ...ROW, ...extra });
    const res = await call();
    expect(res.status).toBe(409);
    expect(m.analyzeDocument).not.toHaveBeenCalled();
    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a document already attached to an order", async () => {
    m.findFirst.mockResolvedValue({ ...ROW, analysisStatus: "NEEDS_REVIEW", orderId: "order-1" });
    const res = await call();
    expect(res.status).toBe(409);
    expect(m.analyzeDocument).not.toHaveBeenCalled();
    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a purged document", async () => {
    m.findFirst.mockResolvedValue({ ...ROW, analysisStatus: "NEEDS_REVIEW", purgedAt: new Date() });
    const res = await call();
    expect(res.status).toBe(409);
    expect(m.analyzeDocument).not.toHaveBeenCalled();
    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it("claims the row on the state it checked, analyses, and writes only while it still holds the claim", async () => {
    const res = await call();
    expect(res.status).toBe(200);

    const [claim] = m.updateMany.mock.calls[0];
    expect(claim.where).toMatchObject({ id: FILE_ID, orderId: null, purgedAt: null, analysisStatus: "PENDING" });
    expect(claim.data).toEqual({ analysisStatus: "PROCESSING" });

    const [write] = m.updateMany.mock.calls[1];
    expect(write.where).toEqual({ id: FILE_ID, orderId: null, purgedAt: null, analysisStatus: "PROCESSING" });
    expect(write.data).toMatchObject({ pageCount: 12, analysisStatus: "COMPLETED" });
  });

  it("refuses the result when the claim was lost, and reports it instead of returning a count", async () => {
    m.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const res = await call();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/changed while it was being analysed/);
  });

  it("refuses to start when another request has already claimed the row", async () => {
    m.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await call();
    expect(res.status).toBe(409);
    expect(m.analyzeDocument).not.toHaveBeenCalled();
  });

  it("releases the claim when analysis throws, so the document can be retried", async () => {
    m.analyzeDocument.mockRejectedValueOnce(new Error("parser crashed"));
    const res = await call();
    expect(res.status).toBe(500);
    const release = m.updateMany.mock.calls.at(-1)![0];
    expect(release.where).toEqual({ id: FILE_ID, analysisStatus: "PROCESSING", orderId: null });
    expect(release.data).toEqual({ analysisStatus: "PENDING" });
  });
});
