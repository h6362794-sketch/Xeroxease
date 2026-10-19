// Route-level regression tests for `POST /api/orders`.
//
// What broke in production: the handler parsed the request body once via
// `parseBody` (which calls `req.json()`) and then called `req.clone().json()`
// to fish `fileIds` out of the same body. Once a Request body has been read,
// undici marks it unusable and `clone()` throws *synchronously* with
// `TypeError: unusable` — the trailing `.catch(() => [])` never attaches to a
// promise chain that was never built, so the error escaped as a 500
// (production request id 0492a3aa-38fa-43c0-ae0c-f6e0a09b87ca).
//
// These tests pin the HTTP contract around `createOrder`:
//   * the body is consumed exactly once and a valid order is created end-to-end,
//   * invalid / incomplete / expired / unauthorized upload references are
//     rejected safely (4xx, no writes, no partial rows),
//   * client-submitted metadata and prices are never trusted,
//   * failed creation leaves no duplicate or partially applied order,
//   * database failures surface a generic 500 without secrets or stack traces.

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";

const USER = "user-1";
const FILE_ID = "file-1";
const OTHER_USER = "someone-else";

type FileRow = {
  id: string;
  uploaderId: string;
  pageCount: number | null;
  analysisStatus: string;
  orderId: string | null;
  status: string;
};

type Row = Record<string, unknown> & { id: string };

// ---- mutable per-test state -----------------------------------------------

let files: FileRow[] = [];
let committedOrders: Row[] = [];
let committedEvents: Record<string, unknown>[] = [];
let orderNumberSeq = 0;
let findManyError: Error | null = null;
let failNextOrderCreate: (Error & { code?: string }) | null = null;
let failEventCreate: Error | null = null;
let session: { id: string; role: string } | null = { id: USER, role: "STUDENT" };
let rateLimitOk = true;

let audit: Mock;
let notifyOrderCreated: Mock;
let routes: typeof import("@/app/api/orders/route");

async function load() {
  audit = vi.fn(async () => undefined);
  notifyOrderCreated = vi.fn(async () => undefined);

  vi.resetModules();

  vi.doMock("@/server/env", () => ({
    env: {
      get TRUSTED_PROXY_COUNT() {
        return 1;
      },
      get SESSION_SECRET() {
        return "x".repeat(40);
      },
    },
  }));

  vi.doMock("@/server/auth", () => ({
    requireUser: vi.fn(async () => {
      if (!session) throw Object.assign(new Error("UNAUTHENTICATED"), { status: 401 });
      return session;
    }),
    getSessionUser: vi.fn(async () => session),
    requireRole: vi.fn(),
    isAdminRole: (role: string) => role === "ADMIN" || role === "SUPER_ADMIN",
  }));

  vi.doMock("@/server/rate-limit", () => ({
    RATE_LIMITS: {
      orderCreate: { limit: 20, windowMs: 60 * 60_000 },
    },
    rateLimitAsync: vi.fn(async () => (rateLimitOk ? { ok: true, remaining: 19 } : { ok: false, retryAfterSec: 60 })),
  }));

  vi.doMock("@/lib/prisma", () => {
    // Interactive transaction mock with rollback semantics: rows written inside
    // `$transaction` only become visible (committed) when the callback
    // resolves, mirroring what the real Prisma transaction guarantees.
    const makeTx = (pendingOrders: Row[], pendingEvents: Record<string, unknown>[]) => ({
      order: {
        findFirst: async () =>
          orderNumberSeq > 0 ? { orderNumber: `XE-2026-${String(orderNumberSeq).padStart(6, "0")}` } : null,
        create: async (args: { data: Record<string, unknown> }) => {
          if (failNextOrderCreate) {
            const err = failNextOrderCreate;
            failNextOrderCreate = null;
            // A unique violation means a *concurrent* order took the number and
            // committed; emulate that so the retry derives a fresh number.
            if (err.code === "P2002") orderNumberSeq++;
            throw err;
          }
          orderNumberSeq++;
          const row = { id: `order-${orderNumberSeq}`, ...args.data };
          pendingOrders.push(row);
          return row;
        },
      },
      orderEvent: {
        create: async (args: { data: Record<string, unknown> }) => {
          if (failEventCreate) throw failEventCreate;
          pendingEvents.push(args.data);
          return args.data;
        },
      },
    });

    return {
      prisma: {
        uploadedFile: {
          findMany: async (args: { where: { id: { in: string[] }; uploaderId: string } }) => {
            if (findManyError) throw findManyError;
            return files.filter(
              (f) => args.where.id.in.includes(f.id) && f.uploaderId === args.where.uploaderId
            );
          },
        },
        order: {
          findFirst: async () =>
            orderNumberSeq > 0 ? { orderNumber: `XE-2026-${String(orderNumberSeq).padStart(6, "0")}` } : null,
          create: async (args: { data: Record<string, unknown> }) => {
            orderNumberSeq++;
            const row = { id: `order-${orderNumberSeq}`, ...args.data };
            committedOrders.push(row);
            return row;
          },
        },
        orderEvent: { create: async () => ({}) },
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
          const pendingOrders: Row[] = [];
          const pendingEvents: Record<string, unknown>[] = [];
          const result = await fn(makeTx(pendingOrders, pendingEvents));
          committedOrders.push(...pendingOrders);
          committedEvents.push(...pendingEvents);
          return result;
        },
      },
    };
  });

  vi.doMock("@/server/settings", () => ({
    getPriceTable: async () => ({
      A4_BW: 2,
      A4_COLOR: 8,
      LEGAL_BW: 3,
      LEGAL_COLOR: 10,
      STAPLE: 5,
      SPIRAL: 40,
      STICK_FILE: 25,
    }),
    getSettings: async () => ({ cancellationAllowedStatuses: ["PAYMENT_PENDING"] }),
  }));

  vi.doMock("@/server/notifications", () => ({
    notify: vi.fn(async () => undefined),
    NOTIFY: {
      orderCreated: (...args: unknown[]) => notifyOrderCreated(...args),
      orderCancelled: vi.fn(async () => undefined),
      statusUpdate: vi.fn(async () => undefined),
      orderReady: vi.fn(async () => undefined),
      orderCompleted: vi.fn(async () => undefined),
      paymentSubmitted: vi.fn(async () => undefined),
      paymentConfirmed: vi.fn(async () => undefined),
      paymentRejected: vi.fn(async () => undefined),
    },
  }));

  vi.doMock("@/server/audit", () => ({ audit }));

  routes = await import("@/app/api/orders/route");
}

beforeEach(async () => {
  files = [];
  committedOrders = [];
  committedEvents = [];
  orderNumberSeq = 0;
  findManyError = null;
  failNextOrderCreate = null;
  failEventCreate = null;
  session = { id: USER, role: "STUDENT" };
  rateLimitOk = true;
  await load();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- helpers ---------------------------------------------------------------

const VALID_CONFIG = {
  paperSize: "A4",
  colorMode: "BW",
  sides: "SINGLE",
  copies: 2,
  pageSelection: "ALL",
  finishing: ["STAPLE"],
};

function verifiedFile(overrides: Partial<FileRow> = {}): FileRow {
  return {
    id: FILE_ID,
    uploaderId: USER,
    pageCount: 10,
    analysisStatus: "COMPLETED",
    orderId: null,
    status: "COMPLETED",
    ...overrides,
  };
}

function orderRequest(body: unknown) {
  return new Request("https://app.test/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
    body: JSON.stringify(body),
  });
}

function orderRequestStreamed(body: unknown) {
  // A streamed body (what the runtime actually hands route handlers) cannot be
  // re-read through a buffered fallback; it fails fast on any double parse.
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return new Request("https://app.test/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    // Node's fetch requires `duplex` when the body is a stream.
    duplex: "half",
  } as RequestInit);
}

async function body(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

// ---- regression: the production 500 ---------------------------------------

describe("POST /api/orders — body handling (regression: TypeError: unusable)", () => {
  it("documents the undici failure mode the old handler hit: clone() after the body was read", async () => {
    // This is exactly what `parseBody(req) … req.clone()` did to the same
    // request: read it once, then clone it. undici throws *synchronously*.
    const req = orderRequest({ ...VALID_CONFIG, fileIds: [FILE_ID] });
    await req.json();
    expect(() => req.clone()).toThrowError(/unusable/);
  });

  it("creates an order for a valid, completed upload reading the body exactly once", async () => {
    files = [verifiedFile()];
    const jsonSpy = vi.spyOn(Request.prototype, "json");
    const cloneSpy = vi.spyOn(Request.prototype, "clone");

    const res = await routes.POST(orderRequest({ ...VALID_CONFIG, fileIds: [FILE_ID] }));

    // Count before the test itself reads the response body.
    expect(jsonSpy).toHaveBeenCalledTimes(1);
    expect(cloneSpy).not.toHaveBeenCalled();

    expect(res.status).toBe(201);
    // The response body is handed to the client unconsumed by the handler.
    expect(res.bodyUsed).toBe(false);
    const out = await body(res);
    expect(out.order).toMatchObject({
      id: "order-1",
      orderNumber: "XE-2026-000001",
      status: "PAYMENT_PENDING",
      paymentStatus: "PAYMENT_PENDING",
    });
    expect(cloneSpy).not.toHaveBeenCalled();
  });

  it("accepts a streamed request body and still creates the order", async () => {
    files = [verifiedFile()];
    const res = await routes.POST(orderRequestStreamed({ ...VALID_CONFIG, fileIds: [FILE_ID] }));
    expect(res.status).toBe(201);
    expect(await body(res)).toMatchObject({ order: { status: "PAYMENT_PENDING" } });
    expect(committedOrders).toHaveLength(1);
  });

  it("returns 400 on a malformed JSON body without touching the database", async () => {
    const res = await routes.POST(
      new Request("https://app.test/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      })
    );
    expect(res.status).toBe(400);
    expect(committedOrders).toHaveLength(0);
    expect(notifyOrderCreated).not.toHaveBeenCalled();
  });
});

// ---- required behaviour ----------------------------------------------------

describe("upload references are validated safely", () => {
  it("rejects a request with no documents attached", async () => {
    const res = await routes.POST(orderRequest({ ...VALID_CONFIG, fileIds: [] }));
    expect(res.status).toBe(400);
    expect(committedOrders).toHaveLength(0);
  });

  it("rejects non-string upload references", async () => {
    const res = await routes.POST(orderRequest({ ...VALID_CONFIG, fileIds: [{ id: FILE_ID }] }));
    expect(res.status).toBe(400);
    expect(committedOrders).toHaveLength(0);
    expect(notifyOrderCreated).not.toHaveBeenCalled();
  });

  it("rejects unauthorized upload references (someone else's document) without writes", async () => {
    files = [verifiedFile({ uploaderId: OTHER_USER })];
    const res = await routes.POST(orderRequest({ ...VALID_CONFIG, fileIds: [FILE_ID] }));
    expect(res.status).toBe(403);
    const out = await body(res);
    expect(JSON.stringify(out)).not.toContain(OTHER_USER);
    expect(committedOrders).toHaveLength(0);
    expect(committedEvents).toHaveLength(0);
    expect(notifyOrderCreated).not.toHaveBeenCalled();
  });

  it("rejects unknown upload references", async () => {
    const res = await routes.POST(orderRequest({ ...VALID_CONFIG, fileIds: ["no-such-file"] }));
    expect(res.status).toBe(403);
    expect(committedOrders).toHaveLength(0);
  });

  it("rejects an incomplete upload (intent never completed — e.g. expired) with 409", async () => {
    // A signed upload intent that expired before completion leaves the row in
    // PENDING: no verified bytes exist, so it must not be orderable.
    files = [verifiedFile({ status: "PENDING" })];
    const res = await routes.POST(orderRequest({ ...VALID_CONFIG, fileIds: [FILE_ID] }));
    expect(res.status).toBe(409);
    expect(committedOrders).toHaveLength(0);
    expect(notifyOrderCreated).not.toHaveBeenCalled();
  });

  it("rejects a rejected/failed upload with 409", async () => {
    files = [verifiedFile({ status: "FAILED" })];
    const res = await routes.POST(orderRequest({ ...VALID_CONFIG, fileIds: [FILE_ID] }));
    expect(res.status).toBe(409);
    expect(committedOrders).toHaveLength(0);
  });

  it("rejects a document that is still being analyzed", async () => {
    files = [verifiedFile({ analysisStatus: "PROCESSING", pageCount: null })];
    const res = await routes.POST(orderRequest({ ...VALID_CONFIG, fileIds: [FILE_ID] }));
    expect(res.status).toBe(409);
    expect(committedOrders).toHaveLength(0);
  });

  it("rejects a document already attached to an order (no double-ordering)", async () => {
    files = [verifiedFile({ orderId: "existing-order" })];
    const res = await routes.POST(orderRequest({ ...VALID_CONFIG, fileIds: [FILE_ID] }));
    expect(res.status).toBe(409);
    expect(committedOrders).toHaveLength(0);
    expect(committedEvents).toHaveLength(0);
  });
});

describe("authentication and authorization", () => {
  it("requires a session before any work", async () => {
    session = null;
    const res = await routes.POST(orderRequest({ ...VALID_CONFIG, fileIds: [FILE_ID] }));
    expect(res.status).toBe(401);
    expect(await body(res)).toMatchObject({ code: "UNAUTHENTICATED" });
    expect(committedOrders).toHaveLength(0);
  });

  it("allows only students to create orders", async () => {
    session = { id: "admin-1", role: "ADMIN" };
    const res = await routes.POST(orderRequest({ ...VALID_CONFIG, fileIds: [FILE_ID] }));
    expect(res.status).toBe(403);
    expect(committedOrders).toHaveLength(0);
  });
});

describe("server-side pricing and order invariants", () => {
  it("never trusts client-submitted metadata or prices", async () => {
    files = [verifiedFile()];
    const res = await routes.POST(
      orderRequest({
        ...VALID_CONFIG,
        fileIds: [FILE_ID],
        // Everything below is client noise that must be ignored.
        pageCount: 999,
        totalPages: 999,
        billablePages: 1,
        pricePerPage: 0.001,
        totalAmount: 1,
        status: "COMPLETED",
        paymentStatus: "PAYMENT_CONFIRMED",
      })
    );
    expect(res.status).toBe(201);
    const out = await body(res);
    // 10 pages * 2 copies = 20 billable pages @ 2 = 40, + 5 staple = 45.
    expect(out.order).toMatchObject({ totalAmount: 45, status: "PAYMENT_PENDING", paymentStatus: "PAYMENT_PENDING" });
    expect(committedOrders[0]).toMatchObject({
      totalPages: 10,
      billablePages: 20,
      pricePerPage: 2,
      finishingFee: 5,
      totalAmount: 45,
      status: "PAYMENT_PENDING",
      paymentStatus: "PAYMENT_PENDING",
    });
  });

  it("records the ORDER_PLACED event and notifies/audits exactly once", async () => {
    files = [verifiedFile()];
    const res = await routes.POST(orderRequest({ ...VALID_CONFIG, fileIds: [FILE_ID] }));
    expect(res.status).toBe(201);
    expect(committedEvents).toHaveLength(1);
    expect(committedEvents[0]).toMatchObject({ type: "ORDER_PLACED", toStatus: "PAYMENT_PENDING", actorId: USER });
    expect(notifyOrderCreated).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0]).toMatchObject({ action: "ORDER_CREATED", actorRole: "STUDENT" });
  });

  it("rejects an invalid configuration before any database write", async () => {
    files = [verifiedFile()];
    const res = await routes.POST(
      orderRequest({ ...VALID_CONFIG, copies: 0, fileIds: [FILE_ID] })
    );
    expect(res.status).toBe(422);
    expect(committedOrders).toHaveLength(0);
    expect(notifyOrderCreated).not.toHaveBeenCalled();
  });
});

describe("failed order creation leaves no partial or duplicate order", () => {
  it("rolls back the order row when the event write fails (all-or-nothing)", async () => {
    files = [verifiedFile()];
    failEventCreate = new Error("connection reset mid-transaction");
    const res = await routes.POST(orderRequest({ ...VALID_CONFIG, fileIds: [FILE_ID] }));
    expect(res.status).toBe(500);
    expect(committedOrders).toHaveLength(0);
    expect(committedEvents).toHaveLength(0);
    expect(notifyOrderCreated).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("retries an order-number collision without creating a duplicate", async () => {
    files = [verifiedFile()];
    failNextOrderCreate = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    const res = await routes.POST(orderRequest({ ...VALID_CONFIG, fileIds: [FILE_ID] }));
    expect(res.status).toBe(201);
    // The first attempt was rolled back; exactly one order is committed.
    expect(committedOrders).toHaveLength(1);
    expect(committedEvents).toHaveLength(1);
    expect(notifyOrderCreated).toHaveBeenCalledTimes(1);
    const out = await body(res);
    expect(out.order).toMatchObject({ orderNumber: "XE-2026-000002" });
  });
});

describe("database failures are handled safely", () => {
  it("returns a generic 500 without secrets, hosts, or stack traces", async () => {
    files = [verifiedFile()];
    findManyError = new Error(
      "Can't reach database host `db.abc123.supabase.co:6543` (pool timeout, connection_limit=1) password=hunter2-secret-role-key\n    at Client.connect (/app/node_modules/pg/lib/client.js:1:1)"
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await routes.POST(orderRequest({ ...VALID_CONFIG, fileIds: [FILE_ID] }));

    expect(res.status).toBe(500);
    const out = await body(res);
    expect(out).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(out.error).toBe("Something went wrong. Please try again.");
    const dump = JSON.stringify(out);
    for (const leak of ["hunter2-secret-role-key", "db.abc123.supabase.co", "connection_limit", "pg/lib/client", "at Client.connect", "pool timeout"]) {
      expect(dump, `response leaked ${leak}`).not.toContain(leak);
    }
    // Failures are logged server-side under a correlation id, never returned.
    expect(errorSpy).toHaveBeenCalled();
    expect(JSON.stringify(errorSpy.mock.calls)).toContain("requestId");
    expect(committedOrders).toHaveLength(0);
    expect(notifyOrderCreated).not.toHaveBeenCalled();
  });
});
