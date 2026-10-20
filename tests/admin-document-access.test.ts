// Administrator document access.
//
// A signed URL is only minted after the file is proven to belong to the order in
// the URL and the upload is verified. Every negative case must look identical to
// the caller (404), so ids cannot be used as an existence oracle.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { authorizeAdminOrderFile, safeContentDisposition } from "@/lib/order-file-access";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const ORDER = "33333333-3333-4333-8333-333333333333";
const OTHER_ORDER = "44444444-4444-4444-8444-444444444444";
const FILE = "55555555-5555-4555-8555-555555555555";
const STUDENT = "77777777-7777-4777-8777-777777777777";

const file = {
  id: FILE,
  orderId: ORDER,
  uploaderId: STUDENT,
  status: "COMPLETED",
  storageKey: "orders/2026/secret-key.pdf",
  originalName: "Assignment 1.pdf",
  mimeType: "application/pdf",
  sizeBytes: 12345,
};
const order = { id: ORDER, userId: STUDENT };

describe("authorizeAdminOrderFile", () => {
  it("allows an admin for a verified file attached to that order", () => {
    expect(authorizeAdminOrderFile({ file, order, actorRole: "ADMIN" })).toEqual({ allowed: true });
    expect(authorizeAdminOrderFile({ file, order, actorRole: "SUPER_ADMIN" })).toEqual({ allowed: true });
  });

  it("refuses students and unknown roles", () => {
    expect(authorizeAdminOrderFile({ file, order, actorRole: "STUDENT" })).toEqual({
      allowed: false,
      reason: "forbidden",
    });
    expect(authorizeAdminOrderFile({ file, order, actorRole: "" }).allowed).toBe(false);
  });

  it("refuses a file that belongs to a different order", () => {
    expect(
      authorizeAdminOrderFile({
        file: { ...file, orderId: OTHER_ORDER },
        order,
        actorRole: "ADMIN",
      })
    ).toEqual({ allowed: false, reason: "missing" });
  });

  it("refuses a file uploaded by someone other than the order's student", () => {
    expect(
      authorizeAdminOrderFile({
        file: { ...file, uploaderId: "someone-else" },
        order,
        actorRole: "ADMIN",
      })
    ).toEqual({ allowed: false, reason: "forbidden" });
  });

  it("refuses incomplete uploads and rows without storage keys", () => {
    expect(
      authorizeAdminOrderFile({ file: { ...file, status: "PENDING" }, order, actorRole: "ADMIN" })
    ).toEqual({ allowed: false, reason: "unverified" });
    expect(
      authorizeAdminOrderFile({ file: { ...file, storageKey: null }, order, actorRole: "ADMIN" })
    ).toEqual({ allowed: false, reason: "unverified" });
  });

  it("refuses missing rows", () => {
    expect(authorizeAdminOrderFile({ file: null, order, actorRole: "ADMIN" }).allowed).toBe(false);
    expect(authorizeAdminOrderFile({ file, order: null, actorRole: "ADMIN" }).allowed).toBe(false);
  });
});

describe("safeContentDisposition", () => {
  it("uses inline for preview and attachment for download", () => {
    expect(safeContentDisposition("notes.pdf", "view")).toMatch(/^inline;/);
    expect(safeContentDisposition("notes.pdf", "download")).toMatch(/^attachment;/);
  });

  it("strips header-breaking characters and path separators", () => {
    const header = safeContentDisposition('evil"\r\nSet-Cookie: x=1/../../etc.pdf', "download");
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.match(/"/g)).toHaveLength(2); // only the quoted-string delimiters
    expect(header).toContain("Set-Cookie_ x=1");
    expect(header).not.toContain("../");
  });

  it("keeps a printable ASCII fallback and RFC 5987 encoding for unicode names", () => {
    const header = safeContentDisposition(" résumé (final)*.pdf", "view");
    expect(header).toContain('filename="r_sum_ (final)_.pdf"');
    expect(header).toContain("filename*=UTF-8''");
    // Characters that are not RFC 5987 attr-char must be percent-encoded.
    expect(header).not.toMatch(/filename\*=UTF-8''[^;]*[()*']/);
  });

  it("falls back to a safe name when nothing usable remains", () => {
    expect(safeContentDisposition("", "download")).toContain('filename="document"');
    expect(safeContentDisposition("   ", "download")).toContain('filename="document"');
  });
});

// ---------------------------------------------------------------------------
// Route-level authorization: the signed URL must not be minted before checks.
// ---------------------------------------------------------------------------

let role = "ADMIN";
let orderRow: { id: string; userId: string } | null;
let fileRow: Record<string, any> | null;
let signMode = true;
let signingFails = false;
let streamFails = false;
let signedUrlCalls: string[];

let route: typeof import("@/app/api/admin/orders/[id]/files/[fileId]/download/route");

async function load() {
  vi.resetModules();
  signedUrlCalls = [];

  vi.doMock("@/server/auth", () => ({
    requireRole: vi.fn(async (...roles: string[]) => {
      if (!roles.includes(role)) throw Object.assign(new Error("Forbidden"), { status: 403 });
      return { id: ADMIN, role };
    }),
  }));

  vi.doMock("@/server/rate-limit", () => ({
    RATE_LIMITS: { download: { limit: 100, windowMs: 60_000 } },
    rateLimitAsync: vi.fn(async () => ({ ok: true, retryAfterSec: 0, remaining: 99 })),
  }));

  vi.doMock("@/lib/prisma", () => ({
    prisma: {
      order: { findUnique: vi.fn(async () => orderRow) },
      uploadedFile: { findUnique: vi.fn(async () => fileRow) },
    },
  }));

  class FakeStorageError extends Error {
    status: number;
    constructor(message: string, status = 502) {
      super(message);
      this.status = status;
    }
  }

  vi.doMock("@/server/storage", () => ({
    StorageError: FakeStorageError,
    openStream: vi.fn(async () => {
      if (streamFails) throw new FakeStorageError("gone", 404);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([37, 80, 68, 70]));
          controller.close();
        },
      });
    }),
  }));

  vi.doMock("@/server/direct-upload/download", () => ({
    shouldSignDownload: () => signMode,
    signedDownloadTtlSeconds: () => 60,
    downloadRedirectHeaders: () => ({ "Cache-Control": "private, no-store" }),
  }));

  vi.doMock("@/server/direct-upload/policy", () => ({
    normalizeDownloadMode: (value: string | null) => (value === "download" ? "download" : "view"),
  }));

  vi.doMock("@/server/direct-upload/storage-bridge", () => ({
    createSignedDownloadUrl: vi.fn(async (key: string) => {
      signedUrlCalls.push(key);
      if (signingFails) throw new FakeStorageError("signing failed", 502);
      return { url: "https://storage.example/private?token=short-lived" };
    }),
  }));

  route = await import("@/app/api/admin/orders/[id]/files/[fileId]/download/route");
}

function request(query = "") {
  return new Request(`https://app.test/api/admin/orders/${ORDER}/files/${FILE}/download${query}`);
}

beforeEach(async () => {
  role = "ADMIN";
  orderRow = { ...order };
  fileRow = { ...file };
  signMode = true;
  signingFails = false;
  streamFails = false;
  await load();
});

describe("GET /api/admin/orders/:id/files/:fileId/download", () => {
  it("refuses non-admin callers before reading any row", async () => {
    role = "STUDENT";
    const res = await route.GET(request(), { params: Promise.resolve({ id: ORDER, fileId: FILE }) });
    expect(res.status).toBe(403);
    expect(signedUrlCalls).toHaveLength(0);
  });

  it("404s an unknown file, a cross-order file and an unverified upload identically", async () => {
    const cases: Array<[Record<string, any> | null, { id: string; userId: string } | null]> = [
      [null, order],
      [{ ...file, orderId: OTHER_ORDER }, order],
      [file, { ...order, userId: "another-student" }],
      [{ ...file, status: "PENDING" }, order],
      [{ ...file, storageKey: null }, order],
    ];

    for (const [f, o] of cases) {
      fileRow = f;
      orderRow = o;
      const res = await route.GET(request(), { params: Promise.resolve({ id: ORDER, fileId: FILE }) });
      expect(res.status).toBe(404);
      const body = (await res.json()) as any;
      expect(body.code).toBe("FILE_NOT_FOUND");
    }
    expect(signedUrlCalls).toHaveLength(0);
  });

  it("rejects malformed ids before querying", async () => {
    const res = await route.GET(new Request("https://app.test/x"), {
      params: Promise.resolve({ id: "../etc", fileId: "not-a-uuid" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns a short-lived redirect for a verified file and never exposes the storage key", async () => {
    const res = await route.GET(request("?mode=view"), {
      params: Promise.resolve({ id: ORDER, fileId: FILE }),
    });

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://storage.example/private?token=short-lived");
    expect(res.headers.get("location")).not.toContain(file.storageKey);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(signedUrlCalls).toEqual([file.storageKey]);
  });

  it("maps a signing outage to a generic 503", async () => {
    signingFails = true;
    const res = await route.GET(request(), { params: Promise.resolve({ id: ORDER, fileId: FILE }) });

    expect(res.status).toBe(503);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("temporarily unavailable");
    expect(text).not.toContain(file.storageKey);
  });

  it("streams locally with safe headers when signing is disabled", async () => {
    signMode = false;
    const res = await route.GET(request("?mode=download"), {
      params: Promise.resolve({ id: ORDER, fileId: FILE }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(
      safeContentDisposition(file.originalName, "download")
    );
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.arrayBuffer()).toEqual(new Uint8Array([37, 80, 68, 70]).buffer);
    expect(signedUrlCalls).toHaveLength(0);
  });

  it("404s locally when the stored object is missing", async () => {
    signMode = false;
    streamFails = true;
    const res = await route.GET(request(), { params: Promise.resolve({ id: ORDER, fileId: FILE }) });

    expect(res.status).toBe(404);
    expect((await res.json() as any).code).toBe("FILE_NOT_FOUND");
  });
});
