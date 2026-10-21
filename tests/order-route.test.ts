// Route-level regression tests for POST /api/orders.
//
// Production symptom this file pins: `POST /api/orders` returned 500 with
// `TypeError: unusable` right after uploads had completed successfully.
//
// The handler parsed the body with `parseBody(req, orderConfigSchema)` (which
// calls `req.json()`) and then called `req.clone().json()` to read `fileIds`
// again. Cloning a Request whose body has already been consumed throws a
// *synchronous* `TypeError: unusable`, so the `.catch()` chained onto the clone
// never ran and every order creation surfaced as a generic 500.
//
// These tests therefore drive the real handler and the real `createOrder`
// service over an in-memory Prisma stand-in, so the whole chain is exercised:
// parsing → ownership/verification checks → server-side pricing → transaction →
// response.

import { describe, it, expect, beforeEach, vi } from "vitest";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const FILE_A = "22222222-2222-4222-8222-222222222222";
const FILE_B = "33333333-3333-4333-8333-333333333333";

interface FileRow {
  id: string;
  uploaderId: string;
  pageCount: number | null;
  analysisStatus: string;
  orderId: string | null;
  status: string;
  intentExpiresAt?: Date | null;
}

let session: { id: string; role: string } | null = { id: OWNER, role: "STUDENT" };
let files: FileRow[] = [];
let committedOrders: any[] = [];
let committedEvents: any[] = [];
let orderSeq = 0;
/** When set, the next orderEvent insert inside a transaction rejects. */
let eventFailure: Error | null = null;
let rateLimited = false;

let createOrderMock: ReturnType<typeof vi.fn>;
let audit: ReturnType<typeof vi.fn>;

type Route = typeof import("@/app/api/orders/route");
let route: Route;
let OrderError: new (message: string, status?: number) => Error & { status: number };

function complete(id: string, overrides: Partial<FileRow> = {}): FileRow {
  return {
    id,
    uploaderId: OWNER,
    pageCount: 10,
    analysisStatus: "COMPLETED",
    orderId: null,
    status: "COMPLETED",
    intentExpiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

async function load() {
  vi.resetModules();
  orderSeq = 0;
  eventFailure = null;

  vi.doMock("@/server/auth", () => ({
    requireUser: vi.fn(async () => {
      if (!session) throw Object.assign(new Error("Unauthorized"), { status: 401 });
      return session;
    }),
    isAdminRole: (role: string) => role === "ADMIN" || role === "SUPER_ADMIN",
  }));

  vi.doMock("@/server/rate-limit", () => ({
    RATE_LIMITS: {
      orderCreate: { limit: 10, windowMs: 60_000 },
    },
    rateLimitAsync: vi.fn(async () =>
      rateLimited
        ? { ok: false, retryAfterSec: 30, remaining: 0 }
        : { ok: true, retryAfterSec: 0, remaining: 9 }
    ),
  }));

  vi.doMock("@/server/audit", () => ({ audit }));

  vi.doMock("@/server/notifications", () => ({
    notify: vi.fn(async () => undefined),
    NOTIFY: {
      orderCreated: vi.fn(async () => undefined),
      orderCancelled: vi.fn(async () => undefined),
      statusUpdate: vi.fn(async () => undefined),
      orderReady: vi.fn(async () => undefined),
      orderCompleted: vi.fn(async () => undefined),
    },
  }));

  vi.doMock("@/server/settings", () => ({
    getPriceTable: vi.fn(async () => ({
      A4_BW: 2,
      A4_COLOR: 8,
      LEGAL_BW: 3,
      LEGAL_COLOR: 10,
      STAPLE: 5,
      SPIRAL: 40,
      STICK_FILE: 25,
    })),
    getSettings: vi.fn(async () => ({ cancellationAllowedStatuses: ["PAYMENT_PENDING"] })),
  }));

  // In-memory Prisma stand-in. Writes are only accepted inside a transaction and
  // are committed when the transaction callback resolves — so a rollback really
  // does leave no order behind. A write attempted on the non-transactional
  // client fails the test loudly.
  vi.doMock("@/lib/prisma", () => ({
    prisma: {
      uploadedFile: {
        findMany: vi.fn(async (args: any) =>
          files.filter(
            (f) => args.where.id.in.includes(f.id) && f.uploaderId === args.where.uploaderId
          )
        ),
      },
      order: {
        create: vi.fn(async () => {
          throw new Error("order.create() must run inside the transaction");
        }),
        findFirst: vi.fn(async () => {
          throw new Error("order.findFirst() must run inside the transaction");
        }),
      },
      orderEvent: {
        create: vi.fn(async () => {
          throw new Error("orderEvent.create() must run inside the transaction");
        }),
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const stagedOrders: any[] = [];
        const stagedEvents: any[] = [];

        const tx = {
          order: {
            findFirst: vi.fn(async (args: any) => {
              const prefix = args.where.orderNumber.startsWith as string;
              const pool = [...committedOrders, ...stagedOrders]
                .map((o) => o.orderNumber as string)
                .filter((n) => n.startsWith(prefix))
                .sort();
              return pool.length ? { orderNumber: pool[pool.length - 1] } : null;
            }),
            create: vi.fn(async (args: any) => {
              const row = {
                id: `order-${++orderSeq}`,
                createdAt: new Date(),
                ...args.data,
              };
              stagedOrders.push(row);
              return row;
            }),
          },
          orderEvent: {
            create: vi.fn(async (args: any) => {
              if (eventFailure) throw eventFailure;
              stagedEvents.push(args.data);
              return args.data;
            }),
          },
        };

        const result = await fn(tx);

        // Commit: persist rows and apply the "connect" side effect on files.
        committedOrders.push(...stagedOrders);
        committedEvents.push(...stagedEvents);
        for (const order of stagedOrders) {
          const connected = order.files?.connect ?? [];
          for (const c of connected) {
            const row = files.find((f) => f.id === c.id);
            if (row) row.orderId = order.id;
          }
        }
        return result;
      }),
    },
  }));

  const realOrders = await vi.importActual<typeof import("@/server/orders")>("@/server/orders");
  OrderError = realOrders.OrderError;
  createOrderMock = vi.fn(realOrders.createOrder);
  vi.doMock("@/server/orders", () => ({
    OrderError: realOrders.OrderError,
    createOrder: createOrderMock,
    canActorChangeStatus: realOrders.canActorChangeStatus,
    isTransitionAllowed: realOrders.isTransitionAllowed,
  }));

  route = await import("@/app/api/orders/route");
}

/**
 * A real `Request`, wrapped so the test can prove the handler reads the body
 * once and never clones it. Any `clone()` call is an instant failure: that is
 * the production bug.
 */
function trackedRequest(body: unknown) {
  const inner = new Request("https://app.test/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const counts = { json: 0, clone: 0 };
  const proxy = new Proxy(inner, {
    get(target, prop) {
      if (prop === "json") {
        return () => {
          counts.json += 1;
          return target.json();
        };
      }
      if (prop === "clone") {
        return () => {
          counts.clone += 1;
          throw new TypeError("unusable");
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as Request;
  return { req: proxy, counts };
}

function post(body: unknown) {
  return trackedRequest(body);
}

const validBody = {
  fileIds: [FILE_A],
  paperSize: "A4",
  colorMode: "BW",
  sides: "SINGLE",
  copies: 1,
  pageSelection: "ALL",
  finishing: [],
};

async function json(res: Response) {
  return (await res.json()) as Record<string, any>;
}

beforeEach(async () => {
  session = { id: OWNER, role: "STUDENT" };
  files = [];
  committedOrders = [];
  committedEvents = [];
  rateLimited = false;
  audit = vi.fn(async () => undefined);
  await load();
});

describe("POST /api/orders — happy path", () => {
  it("creates an order from a completed, verified upload", async () => {
    files = [complete(FILE_A, { pageCount: 10 })];

    const { req, counts } = post(validBody);
    const res = await route.POST(req);

    expect(res.status).toBe(201);
    expect(counts.clone).toBe(0);

    const body = await json(res);
    expect(body.order).toMatchObject({
      // A new order enters the lifecycle at "Order Received"; payment remains a
      // separate axis and starts pending.
      status: "ORDER_RECEIVED",
      paymentStatus: "PAYMENT_PENDING",
      // 10 verified pages × ₹2 (server price table), copies = 1.
      totalAmount: 20,
    });
    expect(body.order.orderNumber).toMatch(/^XE-\d{4}-\d{6}$/);
    expect(committedOrders).toHaveLength(1);
    expect(committedEvents).toHaveLength(1);
    expect(files[0].orderId).toBe(committedOrders[0].id);
  });

  it("reads the request body exactly once", async () => {
    files = [complete(FILE_A)];

    const { req, counts } = post(validBody);
    expect((await route.POST(req)).status).toBe(201);

    expect(counts.json).toBe(1);
    expect(counts.clone).toBe(0);
  });

  it("passes the validated file ids and configuration to createOrder", async () => {
    files = [complete(FILE_A), complete(FILE_B)];

    const { req } = post({
      ...validBody,
      fileIds: [FILE_A, FILE_B],
      copies: 2,
      finishing: ["STAPLE"],
      customPages: "1-3",
      pageSelection: "CUSTOM",
    });
    expect((await route.POST(req)).status).toBe(201);

    expect(createOrderMock).toHaveBeenCalledTimes(1);
    expect(createOrderMock).toHaveBeenCalledWith({
      userId: OWNER,
      fileIds: [FILE_A, FILE_B],
      paperSize: "A4",
      colorMode: "BW",
      sides: "SINGLE",
      copies: 2,
      pageSelection: "CUSTOM",
      customPages: "1-3",
      finishing: ["STAPLE"],
    });
  });

  it("does not let the client set prices, status or page counts", async () => {
    files = [complete(FILE_A, { pageCount: 10 })];

    const { req } = post({
      ...validBody,
      totalAmount: 0.01,
      pricePerPage: 0,
      billablePages: 1,
      totalPages: 1,
      status: "COMPLETED",
      paymentStatus: "PAYMENT_CONFIRMED",
      pageCount: 1,
      userId: OTHER,
    } as unknown);
    const res = await route.POST(req);

    expect(res.status).toBe(201);
    // The server's own price (10 pages × ₹2) wins; no client field crossed over.
    expect((await json(res)).order.totalAmount).toBe(20);
    const passed = createOrderMock.mock.calls[0][0] as Record<string, unknown>;
    for (const key of ["totalAmount", "pricePerPage", "billablePages", "totalPages", "status", "paymentStatus", "pageCount"]) {
      expect(passed).not.toHaveProperty(key);
    }
    expect(passed.userId).toBe(OWNER);
  });
});

describe("POST /api/orders — invalid upload references", () => {
  it("rejects a body without file ids before touching the database", async () => {
    files = [complete(FILE_A)];

    for (const body of [{ ...validBody, fileIds: [] }, { ...validBody, fileIds: undefined }]) {
      const { req } = post(body as unknown);
      const res = await route.POST(req);
      expect(res.status).toBe(422);
      expect((await json(res)).code).toBe("VALIDATION_ERROR");
    }
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it("rejects a non-UUID id instead of letting Postgres cast it", async () => {
    files = [complete(FILE_A)];

    for (const fileIds of [["not-a-uuid"], ["../../etc/passwd"], [1, 2]]) {
      const { req } = post({ ...validBody, fileIds } as unknown);
      const res = await route.POST(req);
      expect(res.status, JSON.stringify(fileIds)).toBe(422);
    }
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it("rejects more than the per-order document limit", async () => {
    const tooMany = Array.from({ length: 11 }, (_, i) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`);
    const { req } = post({ ...validBody, fileIds: tooMany });
    const res = await route.POST(req);

    expect(res.status).toBe(422);
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it("surfaces a foreign document as a 403 without creating anything", async () => {
    files = [complete(FILE_A, { uploaderId: OTHER })];

    const { req } = post(validBody);
    const res = await route.POST(req);

    expect(res.status).toBe(403);
    // 403 is deliberately flattened by withErrorHandling: the client must not learn
    // whether the document exists, only that this session may not order it.
    expect((await json(res)).error).toBe("You do not have permission to perform this action.");
    expect(committedOrders).toHaveLength(0);
  });

  it("refuses an upload that was never completed or has expired", async () => {
    for (const status of ["PENDING", "FAILED", "REJECTED", "PROCESSING"]) {
      files = [complete(FILE_A, { status, intentExpiresAt: new Date(Date.now() - 60_000) })];
      committedOrders = [];

      const { req } = post(validBody);
      const res = await route.POST(req);
      expect(res.status, status).toBe(409);
      expect(committedOrders).toHaveLength(0);
    }
  });

  it("refuses a document that has not been analyzed", async () => {
    files = [complete(FILE_A, { analysisStatus: "PENDING", pageCount: null })];

    const { req } = post(validBody);
    const res = await route.POST(req);

    expect(res.status).toBe(409);
    expect(committedOrders).toHaveLength(0);
  });

  it("refuses to attach one document to a second order", async () => {
    files = [complete(FILE_A, { orderId: "order-existing" })];

    const { req } = post(validBody);
    const res = await route.POST(req);

    expect(res.status).toBe(409);
    expect((await json(res)).error).toMatch(/already attached/i);
    expect(committedOrders).toHaveLength(0);
  });

  it("rejects malformed JSON with a safe 400", async () => {
    const { req } = post("{not json");
    const res = await route.POST(req);

    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("Invalid JSON body");
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it("rejects an empty body", async () => {
    const req = new Request("https://app.test/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const res = await route.POST(req);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/orders — authentication and rate limiting", () => {
  it("requires a session", async () => {
    session = null;
    const { req } = post(validBody);
    const res = await route.POST(req);

    expect(res.status).toBe(401);
    expect((await json(res)).code).toBe("UNAUTHENTICATED");
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it("refuses non-student roles", async () => {
    session = { id: OWNER, role: "ADMIN" };
    const { req } = post(validBody);
    const res = await route.POST(req);

    expect(res.status).toBe(403);
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it("answers 429 without parsing the body", async () => {
    rateLimited = true;
    files = [complete(FILE_A)];

    const { req, counts } = post(validBody);
    const res = await route.POST(req);

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(counts.json).toBe(0);
    expect(createOrderMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/orders — failure handling", () => {
  it("leaves no order or event behind when the transaction fails, and a retry succeeds once", async () => {
    files = [complete(FILE_A)];
    eventFailure = new Error("insert failed");
    // The handler logs the 5xx server-side; keep the test output quiet.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const first = post(validBody);
    const failed = await route.POST(first.req);
    consoleError.mockRestore();
    expect(failed.status).toBe(500);
    expect(committedOrders).toHaveLength(0);
    expect(committedEvents).toHaveLength(0);
    expect(files[0].orderId).toBeNull();

    // Retry after the transient failure — exactly one order, no duplicates.
    eventFailure = null;
    const second = post(validBody);
    const ok = await route.POST(second.req);
    expect(ok.status).toBe(201);
    expect(committedOrders).toHaveLength(1);
    expect(committedEvents).toHaveLength(1);
  });

  it("returns a 503 for transient pool failures and never leaks connection details", async () => {
    const secret = "postgresql://postgres:super-secret@aws-0.pooler.supabase.com:6543/postgres";
    createOrderMock.mockRejectedValueOnce(
      Object.assign(new Error(`Timed out fetching a new connection: ${secret}`), { code: "P2024" })
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const { req } = post(validBody);
      const res = await route.POST(req);

      expect(res.status).toBe(503);
      const body = await json(res);
      expect(body).toMatchObject({ error: expect.any(String), code: "SERVICE_UNAVAILABLE" });
      const serialised = JSON.stringify(body);
      expect(serialised).not.toContain("postgresql://");
      expect(serialised).not.toContain("super-secret");
      expect(serialised).not.toContain("P2024");
      expect(serialised).not.toContain("at ");

      // The detail is logged server-side with a correlation id instead.
      expect(consoleError).toHaveBeenCalled();
      const correlation = consoleError.mock.calls.some(
        (call) => typeof call[1] === "object" && call[1] !== null && "requestId" in (call[1] as object)
      );
      expect(correlation).toBe(true);
      const logged = consoleError.mock.calls
        .map((call) => call.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "))
        .join("\n");
      expect(logged).toContain("Timed out fetching a new connection");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps the deliberate 4xx contract for domain rejections", async () => {
    createOrderMock.mockRejectedValueOnce(new OrderError("Custom page selection is required.", 400));
    const { req } = post(validBody);
    const res = await route.POST(req);

    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatch(/custom page selection/i);
    expect(committedOrders).toHaveLength(0);
  });

  it("masks a 5xx domain error (e.g. pricing unavailable) as a generic 500", async () => {
    createOrderMock.mockRejectedValueOnce(new OrderError("Pricing is not configured yet.", 503));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { req } = post(validBody);
      const res = await route.POST(req);

      expect(res.status).toBe(500);
      expect((await json(res)).error).toBe("Something went wrong. Please try again.");
    } finally {
      consoleError.mockRestore();
    }
  });
});
