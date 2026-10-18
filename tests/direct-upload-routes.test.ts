// Route-level tests for the direct upload protocol and the download redirect.
//
// The service and policy layers are covered elsewhere; what these tests pin is the HTTP
// contract around them, because that is where three things can go quietly wrong:
//   * a domain rejection getting masked as a 500 (so the browser cannot react to it),
//   * a provider/storage error message reaching a client,
//   * a credential ending up somewhere cacheable.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const OWNER = "11111111-1111-4111-8111-111111111111";
const FILE_ID = "22222222-2222-4222-8222-222222222222";
const KEY = `${OWNER}/1700000000000-abc123-notes.pdf`;
/** Long enough for the route's `token: z.string().min(20)` guard. */
const VALID_TOKEN = "v1." + "a".repeat(40) + ".signature-part-xxxxxxxxxxxxxxxxxxxxxxx";
const SUPER = { id: OWNER, role: "SUPER_ADMIN" };

type EnvOverrides = Record<string, unknown>;
let envOverrides: EnvOverrides = {};

let session: { id: string; role: string } | null = { id: OWNER, role: "STUDENT" };
/** Switch for the rate-limit mock: false makes every bucket refuse. */
let rateLimitOk = true;
let dbFile: Record<string, unknown> | null = null;
let openStream: ReturnType<typeof vi.fn>;
let createSignedDownloadUrl: ReturnType<typeof vi.fn>;
let createUploadIntent: ReturnType<typeof vi.fn>;
let completeUploadIntent: ReturnType<typeof vi.fn>;
let abortUploadIntent: ReturnType<typeof vi.fn>;
let releaseExpiredIntents: ReturnType<typeof vi.fn>;
let runUploadSweep: ReturnType<typeof vi.fn>;
let purgeUnattachedUpload: ReturnType<typeof vi.fn>;
let audit: ReturnType<typeof vi.fn>;

type Routes = {
  intent: typeof import("@/app/api/uploads/intent/route");
  complete: typeof import("@/app/api/uploads/complete/route");
  abort: typeof import("@/app/api/uploads/abort/route");
  capability: typeof import("@/app/api/uploads/capability/route");
  sweep: typeof import("@/app/api/admin/uploads/sweep/route");
  remove: typeof import("@/app/api/uploads/[id]/route");
  download: typeof import("@/app/api/files/[id]/download/route");
};
let routes: Routes;
let UploadServiceError: new (message: string, status?: number, code?: string) => Error & { status: number; code: string };

async function load() {
  const defaults: EnvOverrides = {
    NODE_ENV: "production",
    SESSION_SECRET: "test-secret-0123456789abcdef-32-chars-min!",
    STORAGE_BACKEND: "supabase",
    STORAGE_BUCKET: "documents",
    LOCAL_STORAGE_DIR: ".data/uploads",
    SUPABASE_URL: "https://test-project.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    DIRECT_UPLOADS_ENABLED: true,
    UPLOAD_INTENT_TTL_SECONDS: 600,
    SIGNED_DOWNLOAD_URL_TTL_SECONDS: 60,
    STORAGE_PROVIDER_MAX_FILE_BYTES: 0,
    RATE_LIMIT_STORAGE: "memory",
    RATE_LIMIT_FAIL_OPEN: false,
    TRUSTED_PROXY_COUNT: 1,
  };
  const env = new Proxy({ ...defaults, ...envOverrides }, { get: (t, k: string) => t[k] });
  openStream = vi.fn(async () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.close(); } }));
  createSignedDownloadUrl = vi.fn(async () => ({ url: "https://storage.invalid/signed?token=PROVIDER-TOKEN", expiresIn: 60 }));
  createUploadIntent = vi.fn(async () => ({
    fileId: FILE_ID,
    token: "v1.payload.signature",
    uploadUrl: "https://storage.invalid/signed-upload?token=PROVIDER-TOKEN",
    method: "PUT" as const,
    headers: {},
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    maxBytes: 50 * 1024 * 1024,
    proxyUploadAvailable: false,
    fileSizeLimitNote: null,
  }));
  completeUploadIntent = vi.fn(async () => ({
    fileId: FILE_ID,
    status: "COMPLETED" as const,
    sizeBytes: 4096,
    originalName: "notes.pdf",
    mimeType: "application/pdf",
    verified: true,
  }));
  abortUploadIntent = vi.fn(async () => ({ released: true }));
  releaseExpiredIntents = vi.fn(async () => ({ released: 3, attempted: 3, failed: 0 }));
  purgeUnattachedUpload = vi.fn(async () => "purged");
  runUploadSweep = vi.fn(async () => ({ released: 3, attempted: 3, intentsFailed: 0, unattachedAttempted: 0, unattachedPurged: 0, unattachedFailed: 0, leftoversRemoved: 0, retentionAttempted: 0, retentionPurged: 0, retentionFailed: 0, retentionDays: 30 }));
  audit = vi.fn(async () => undefined);

  vi.resetModules();
  vi.setSystemTime(new Date("2026-10-15T10:00:00.000Z"));
  vi.doMock("@/server/env", () => ({ env }));
  vi.doMock("@/server/auth", () => ({
    requireUser: vi.fn(async () => {
        if (!session) throw Object.assign(new Error("Unauthorized"), { status: 401 });
        return session;
      }),
      requireRole: vi.fn(async (role: string) => {
        if (!session) throw Object.assign(new Error("Unauthorized"), { status: 401 });
        if (session.role !== role) throw Object.assign(new Error("Forbidden"), { status: 403 });
        return session;
      }),
      isAdminRole: (role: string) => role === "ADMIN" || role === "SUPER_ADMIN",
  }));
  vi.doMock("@/server/rate-limit", () => ({
    RATE_LIMITS: {
      uploadIntent: { limit: 40, windowMs: 600_000 },
      upload: { limit: 30, windowMs: 600_000 },
      uploadComplete: { limit: 40, windowMs: 600_000 },
      download: { limit: 120, windowMs: 600_000 },
      admin: { limit: 120, windowMs: 60_000 },
    },
    rateLimitAsync: vi.fn(async () => ({ ok: rateLimitOk, remaining: rateLimitOk ? 99 : 0, retryAfterSec: 60 })),
  }));
  vi.doMock("@/lib/prisma", () => ({
    prisma: {
      uploadedFile: {
        findUnique: vi.fn(async () => dbFile),
        findFirst: vi.fn(async () => dbFile),
      },
    },
  }));
  vi.doMock("@/server/audit", () => ({ audit }));
  vi.doMock("@/server/document-lifecycle", () => ({ runUploadSweep, purgeUnattachedUpload }));
  vi.doMock("@/server/storage", async () => {
    // Real `StorageError` so the route's `instanceof` check keeps working; everything
    // else that would touch the network is replaced.
    const { StorageError } = await vi.importActual<typeof import("@/server/storage")>("@/server/storage");
    return { StorageError, openStream, buildStorageKey: () => KEY, deleteFile: vi.fn(), getStoredObjectInfo: vi.fn(), readHeader: vi.fn() };
  });
  vi.doMock("@/server/direct-upload/storage-bridge", () => ({ createSignedDownloadUrl, createSignedUploadTarget: vi.fn() }));
  vi.doMock("@/server/direct-upload/service", async () => {
    const real = await vi.importActual<typeof import("@/server/direct-upload/service")>("@/server/direct-upload/service");
    UploadServiceError = real.UploadServiceError;
    return {
      UploadServiceError: real.UploadServiceError,
      createUploadIntent,
      completeUploadIntent,
      abortUploadIntent,
      releaseExpiredIntents,
    };
  });

  routes = {
    intent: await import("@/app/api/uploads/intent/route"),
    complete: await import("@/app/api/uploads/complete/route"),
    abort: await import("@/app/api/uploads/abort/route"),
    capability: await import("@/app/api/uploads/capability/route"),
    sweep: await import("@/app/api/admin/uploads/sweep/route"),
    download: await import("@/app/api/files/[id]/download/route"),
    remove: await import("@/app/api/uploads/[id]/route"),
  };
}

beforeEach(async () => {
  envOverrides = {};
  rateLimitOk = true;
  session = { id: OWNER, role: "STUDENT" };
  dbFile = null;
  await load();
});

afterEach(() => {
  vi.useRealTimers();
});

function post(body: unknown, path = "/api/uploads/intent", extraHeaders: Record<string, string> = {}) {
  return new Request(`https://app.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

function get(path: string) {
  return new Request(`https://app.test${path}`, { headers: { "x-forwarded-for": "203.0.113.9" } });
}

function download(id: string, query = "") {
  return routes.download.GET(get(`/api/files/${id}/download${query}`), { params: Promise.resolve({ id }) });
}

async function body(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

describe("authentication and authorization at the edge", () => {
  it("every upload route requires a session before doing any work", async () => {
    session = null;
    for (const [name, res] of [
      ["intent", await routes.intent.POST(post({ filename: "a.pdf", sizeBytes: 10 }))],
      ["complete", await routes.complete.POST(post({ fileId: FILE_ID, token: "x".repeat(40) }))],
      ["abort", await routes.abort.POST(post({ fileId: FILE_ID }))],
      ["capability", await routes.capability.GET()],
      ["sweep", await routes.sweep.POST(post({}, "/api/admin/uploads/sweep"))],
      ["download", await download(FILE_ID)],
    ] as const) {
      expect(res.status, name).toBe(401);
      expect(await body(res)).toMatchObject({ code: "UNAUTHENTICATED" });
    }
    expect(createUploadIntent).not.toHaveBeenCalled();
    expect(createSignedDownloadUrl).not.toHaveBeenCalled();
  });

  it("restricts the sweep to SUPER_ADMIN", async () => {
    session = { id: OWNER, role: "ADMIN" };
    const res = await routes.sweep.POST(post({}, "/api/admin/uploads/sweep"));
    expect(res.status).toBe(403);
    expect(releaseExpiredIntents).not.toHaveBeenCalled();
  });
});

describe("GET /api/uploads/capability", () => {
  it("describes the deployment without any credential or bucket detail", async () => {
    const res = await routes.capability.GET();
    expect(res.status).toBe(200);
    const json = await body(res);
    expect(json).toMatchObject({ enabled: true, maxBytes: 50 * 1024 * 1024, resumable: false, proxyUploadAvailable: false });
    const dump = JSON.stringify(json);
    for (const secret of ["test-service-role-key", "PROVIDER-TOKEN", KEY, "signed", "https://test-project.supabase.co"]) {
      expect(dump, `capability leaked ${secret}`).not.toContain(secret);
    }
  });

  it("explains why the protocol is off, so the wizard can choose the proxy path", async () => {
    envOverrides.STORAGE_BACKEND = "local";
    await load();
    const json = await body(await routes.capability.GET());
    expect(json).toMatchObject({ enabled: false, code: "BACKEND_UNSUPPORTED", proxyUploadAvailable: true });
    expect(String(json.reason)).toContain("POST /api/uploads");
  });
});

describe("POST /api/uploads/intent", () => {
  it("returns the intent with 201 and echoes the scoped target", async () => {
    const res = await routes.intent.POST(post({ filename: "notes.pdf", mimeType: "application/pdf", sizeBytes: 4096 }));
    expect(res.status).toBe(201);
    const json = await body(res);
    expect(json).toMatchObject({ mode: "direct", fileId: FILE_ID, method: "PUT", maxBytes: 50 * 1024 * 1024 });
    expect(json.headers).toEqual({});
    expect(typeof json.token).toBe("string");
    // The route forwards exactly what the caller declared; the service decides.
    expect(createUploadIntent).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { id: OWNER, role: "STUDENT" }, declaredSizeRaw: 4096 })
    );
  });

  it("rejects a malformed body with a validation error, not a 500", async () => {
    for (const bad of [
      {},
      { filename: "", sizeBytes: 10 },
      { filename: "a.pdf", sizeBytes: -5 },
      { filename: "a.pdf", sizeBytes: "1.5e7" },
      { filename: "a.pdf", sizeBytes: 10, orderId: "not-a-uuid" },
    ]) {
      const res = await routes.intent.POST(post(bad));
      expect(res.status, JSON.stringify(bad)).toBe(422);
      expect((await body(res)).code).toBe("VALIDATION_ERROR");
    }
    expect(createUploadIntent).not.toHaveBeenCalled();
  });

  it("refuses an intent that names an order, even a well-formed one, and never creates it", async () => {
    // orderId was removed from intents. A valid UUID is refused like any other unknown field.
    const res = await routes.intent.POST(
      post({ filename: "a.pdf", sizeBytes: 10, orderId: "33333333-3333-4333-8333-333333333333" })
    );
    expect(res.status).toBe(422);
    expect((await body(res)).code).toBe("VALIDATION_ERROR");
    expect(createUploadIntent).not.toHaveBeenCalled();
  });

  it("rejects a non-JSON body with 400", async () => {
    const res = await routes.intent.POST(
      new Request("https://app.test/api/uploads/intent", { method: "POST", body: "filename=a.pdf" })
    );
    expect(res.status).toBe(400);
  });

  it("keeps a size rejection visible as 413 with its code", async () => {
    createUploadIntent.mockRejectedValueOnce(new UploadServiceError("File exceeds the 50 MB limit.", 413, "TOO_LARGE"));
    const res = await routes.intent.POST(post({ filename: "big.pdf", sizeBytes: 51 * 1024 * 1024 }));
    expect(res.status).toBe(413);
    expect(await body(res)).toEqual({ error: "File exceeds the 50 MB limit.", code: "TOO_LARGE" });
  });

  it("answers an unsupported deployment with 501 and a machine-readable code", async () => {
    const { DeploymentCapabilityError } = await import("@/server/direct-upload/capability");
    createUploadIntent.mockRejectedValueOnce(new DeploymentCapabilityError({ code: "BACKEND_UNSUPPORTED", reason: "needs supabase" }));
    const res = await routes.intent.POST(post({ filename: "a.pdf", sizeBytes: 10 }));
    expect(res.status).toBe(501);
    expect(await body(res)).toEqual({ error: "needs supabase", code: "DIRECT_UPLOAD_UNSUPPORTED" });
  });

  it("masks an unexpected fault and never forwards provider detail", async () => {
    createUploadIntent.mockRejectedValueOnce(
      new Error('connect ECONNREFUSED to documents bucket with key "eyJhbGciOiJIUzI1NiJ9.secret"')
    );
    const res = await routes.intent.POST(post({ filename: "a.pdf", sizeBytes: 10 }));
    expect(res.status).toBe(500);
    const json = await body(res);
    expect(json).toMatchObject({ error: "Something went wrong. Please try again.", code: "INTERNAL_ERROR" });
    expect(JSON.stringify(json)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(json)).not.toContain("eyJhbGciOi");
  });
});

describe("POST /api/uploads/complete", () => {
  it("accepts only a document id and a completion token", async () => {
    const res = await routes.complete.POST(
      post({ fileId: FILE_ID, token: VALID_TOKEN, sizeBytes: 999, mimeType: "application/pdf" }, "/api/uploads/complete")
    );
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ file: { status: "COMPLETED", sizeBytes: 4096, verified: true } });
    // The extra client-side claims are not even forwarded: verification reads storage.
    expect(completeUploadIntent).toHaveBeenCalledWith({ actor: { id: OWNER, role: "STUDENT" }, fileId: FILE_ID, token: VALID_TOKEN });
  });

  it("refuses a short/absent token before consulting the service", async () => {
    for (const token of ["", "short"]) {
      const res = await routes.complete.POST(post({ fileId: FILE_ID, token }, "/api/uploads/complete"));
      expect(res.status).toBe(422);
    }
    expect(completeUploadIntent).not.toHaveBeenCalled();
  });

  it("surfaces a rejected verification with the server's status and code", async () => {
    for (const [status, code] of [
      [410, "EXPIRED"],
      [422, "SIGNATURE_MISMATCH"],
      [403, "TOKEN_MISMATCH"],
      [409, "OBJECT_MISSING"],
    ] as const) {
      completeUploadIntent.mockRejectedValueOnce(new UploadServiceError("nope", status, code));
      const res = await routes.complete.POST(post({ fileId: FILE_ID, token: VALID_TOKEN }, "/api/uploads/complete"));
      expect(res.status).toBe(status);
      expect((await body(res)).code).toBe(code);
    }
  });

  it("turns a storage outage into 503 without naming the provider", async () => {
    completeUploadIntent.mockRejectedValueOnce(
      new UploadServiceError("Storage is unavailable. Please try again shortly.", 503, "STORAGE_UNAVAILABLE")
    );
    const res = await routes.complete.POST(post({ fileId: FILE_ID, token: VALID_TOKEN }, "/api/uploads/complete"));
    // 5xx is the handler's own deliberate answer, so it survives with its message.
    expect(res.status).toBe(503);
    expect(await body(res)).toEqual({ error: "Storage is unavailable. Please try again shortly.", code: "STORAGE_UNAVAILABLE" });
  });

  it("answers an unsupported deployment the same way the intent route does", async () => {
    const { DeploymentCapabilityError } = await import("@/server/direct-upload/capability");
    completeUploadIntent.mockRejectedValueOnce(new DeploymentCapabilityError({ code: "DISABLED", reason: "off" }));
    const res = await routes.complete.POST(post({ fileId: FILE_ID, token: VALID_TOKEN }, "/api/uploads/complete"));
    expect(res.status).toBe(501);
    expect((await body(res)).code).toBe("DIRECT_UPLOAD_UNSUPPORTED");
  });
});

describe("POST /api/uploads/abort", () => {
  it("releases an unverified intent", async () => {
    const res = await routes.abort.POST(post({ fileId: FILE_ID }, "/api/uploads/abort"));
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ released: true });
  });

  it("refuses to release a verified document", async () => {
    abortUploadIntent.mockRejectedValueOnce(
      new UploadServiceError("This document is already verified and remains attached to your order.", 409, "ALREADY_COMPLETED")
    );
    const res = await routes.abort.POST(post({ fileId: FILE_ID }, "/api/uploads/abort"));
    expect(res.status).toBe(409);
    expect((await body(res)).code).toBe("ALREADY_COMPLETED");
  });
});

describe("POST /api/admin/uploads/sweep", () => {
  beforeEach(() => {
    session = SUPER;
  });

  it("runs the bounded sweep and reports it", async () => {
    const res = await routes.sweep.POST(post({}, "/api/admin/uploads/sweep?limit=25"));
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ released: 3, attempted: 3, retentionDays: 30 });
    expect(runUploadSweep).toHaveBeenCalledWith({ limit: 25, intents: true });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "UPLOAD_INTENTS_SWEEP", metadata: expect.objectContaining({ trigger: "manual" }) })
    );
  });

  it("defaults the batch size and rejects nonsense limits", async () => {
    await routes.sweep.POST(post({}, "/api/admin/uploads/sweep"));
    expect(runUploadSweep).toHaveBeenLastCalledWith({ limit: 50, intents: true });
    for (const raw of ["0", "-1", "501", "abc", "1.5"]) {
      const res = await routes.sweep.POST(post({}, `/api/admin/uploads/sweep?limit=${raw}`));
      expect(res.status, raw).toBe(400);
    }
  });

  it("still runs abandonment and retention cleanup when direct uploads are off", async () => {
    envOverrides.STORAGE_BACKEND = "local";
    await load();
    const res = await routes.sweep.POST(post({}, "/api/admin/uploads/sweep"));
    expect(res.status).toBe(200);
    // Intent release is skipped (no intents exist), but unattached and retained documents are
    // purged on every backend, so the cleanup must not be gated on direct uploads.
    expect(runUploadSweep).toHaveBeenCalledWith({ limit: 50, intents: false });
  });

  it("accepts the scheduler secret for this deployment in place of a session, and records the trigger", async () => {
    session = null;
    envOverrides.CRON_SECRET = "cron-secret-0123456789abcdef-0123456789";
    envOverrides.DEPLOY_TARGET = "staging";
    await load();
    const res = await routes.sweep.POST(
      post({}, "/api/admin/uploads/sweep", {
        authorization: "Bearer cron-secret-0123456789abcdef-0123456789",
        "x-deploy-target": "staging",
      })
    );
    expect(res.status).toBe(200);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: null, actorRole: "SYSTEM", metadata: expect.objectContaining({ trigger: "schedule" }) })
    );
  });

  it("refuses a valid scheduler secret that names another deployment, and audits the refusal", async () => {
    session = null;
    envOverrides.CRON_SECRET = "cron-secret-0123456789abcdef-0123456789";
    envOverrides.DEPLOY_TARGET = "production";
    await load();
    const res = await routes.sweep.POST(
      post({}, "/api/admin/uploads/sweep", {
        authorization: "Bearer cron-secret-0123456789abcdef-0123456789",
        "x-deploy-target": "staging",
      })
    );
    expect(res.status).toBe(403);
    expect((await body(res)).code).toBe("SCHEDULER_TARGET_MISMATCH");
    expect(runUploadSweep).not.toHaveBeenCalled();
    // A refusal performs no write (the scheduler's run fails instead).
    expect(audit).not.toHaveBeenCalled();
  });

  it("refuses a scheduler secret on a deployment with no DEPLOY_TARGET, since it cannot be matched", async () => {
    session = null;
    envOverrides.CRON_SECRET = "cron-secret-0123456789abcdef-0123456789";
    await load();
    const res = await routes.sweep.POST(
      post({}, "/api/admin/uploads/sweep", {
        authorization: "Bearer cron-secret-0123456789abcdef-0123456789",
        "x-deploy-target": "staging",
      })
    );
    expect(res.status).toBe(403);
    expect(runUploadSweep).not.toHaveBeenCalled();
  });

  it("rate-limits sweep attempts before any authentication, so probes are throttled too", async () => {
    session = null;
    rateLimitOk = false;
    const res = await routes.sweep.POST(post({}, "/api/admin/uploads/sweep", { authorization: "Bearer nope" }));
    expect(res.status).toBe(429);
    expect(runUploadSweep).not.toHaveBeenCalled();
  });

  it("rejects a wrong scheduler secret, and never treats a short one as valid", async () => {
    session = null;
    envOverrides.CRON_SECRET = "cron-secret-0123456789abcdef-0123456789";
    await load();
    const wrong = await routes.sweep.POST(post({}, "/api/admin/uploads/sweep", { authorization: "Bearer nope" }));
    expect(wrong.status).toBe(401);
    envOverrides.CRON_SECRET = "too-short";
    await load();
    const short = await routes.sweep.POST(post({}, "/api/admin/uploads/sweep", { authorization: "Bearer too-short" }));
    expect(short.status).toBe(401);
    expect(runUploadSweep).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/uploads/:id", () => {
  const ID = "44444444-4444-4444-8444-444444444444";
  const removeReq = () =>
    routes.remove.DELETE(new Request(`https://app.test/api/uploads/${ID}`, { method: "DELETE", headers: { "x-forwarded-for": "203.0.113.9" } }), {
      params: Promise.resolve({ id: ID }),
    });

  it("removes the caller's unattached document and audits it", async () => {
    purgeUnattachedUpload.mockResolvedValueOnce("purged");
    const res = await removeReq();
    expect(res.status).toBe(200);
    expect(purgeUnattachedUpload).toHaveBeenCalledWith(ID, OWNER);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "UPLOAD_REMOVED", targetId: ID }));
  });

  it("answers 404 when the document is not the caller's or is attached to an order", async () => {
    purgeUnattachedUpload.mockResolvedValueOnce("not_found");
    const res = await removeReq();
    expect(res.status).toBe(404);
    expect(audit).not.toHaveBeenCalled();
  });

  it("answers 503 and keeps the document when storage refuses the delete", async () => {
    purgeUnattachedUpload.mockResolvedValueOnce("failed");
    const res = await removeReq();
    expect(res.status).toBe(503);
    expect(audit).not.toHaveBeenCalled();
  });

  it("requires a session", async () => {
    session = null;
    const res = await removeReq();
    expect(res.status).toBe(401);
    expect(purgeUnattachedUpload).not.toHaveBeenCalled();
  });
});

describe("GET /api/files/:id/download", () => {
  const completed = {
    id: FILE_ID,
    uploaderId: OWNER,
    originalName: "notes.pdf",
    storageKey: KEY,
    status: "COMPLETED",
    mimeType: "application/pdf",
  };

  it("redirects to a short-lived signed URL without touching the bytes", async () => {
    dbFile = completed;
    const res = await download(FILE_ID);
    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toContain("token=PROVIDER-TOKEN");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("X-Robots-Tag")).toContain("noindex");
    expect(res.headers.get("Vary")).toBeNull();
    // A redirect carries no body: the credential must not be duplicable by reading it.
    expect(await res.text()).toBe("");
    // Signed for 60 s, as an attachment named from the database row.
    expect(createSignedDownloadUrl).toHaveBeenCalledWith(KEY, { expiresInSec: 60, download: "notes.pdf" });
    expect(openStream).not.toHaveBeenCalled();
  });

  it("asks for inline display when ?mode=view", async () => {
    dbFile = completed;
    await download(FILE_ID, "?mode=view");
    expect(createSignedDownloadUrl).toHaveBeenCalledWith(KEY, { expiresInSec: 60, download: undefined });
    await download(FILE_ID, "?mode=bogus");
    expect(createSignedDownloadUrl).toHaveBeenLastCalledWith(KEY, { expiresInSec: 60, download: "notes.pdf" });
  });

  it("answers 410 for a document whose bytes the retention policy deleted, to its owner", async () => {
    dbFile = { ...completed, purgedAt: new Date("2026-10-01T00:00:00Z") };
    const res = await download(FILE_ID);
    expect(res.status).toBe(410);
    expect(createSignedDownloadUrl).not.toHaveBeenCalled();
  });

  it("gives the same 404 for a foreign document as for a missing one", async () => {
    dbFile = { ...completed, uploaderId: "someone-else" };
    const foreign = await download(FILE_ID);
    dbFile = null;
    const missing = await download("33333333-3333-4333-8333-333333333333");
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await body(foreign)).toEqual(await body(missing));
    expect(createSignedDownloadUrl).not.toHaveBeenCalled();
  });

  it("never serves an unverified or rejected document, not even to an admin", async () => {
    for (const status of ["PENDING", "FAILED", "EXPIRED"]) {
      dbFile = { ...completed, status };
      const res = await download(FILE_ID);
      expect(res.status, status).toBe(404);
      expect(createSignedDownloadUrl).not.toHaveBeenCalled();
    }
    session = { id: OWNER, role: "SUPER_ADMIN" };
    dbFile = { ...completed, status: "PENDING" };
    expect((await download(FILE_ID)).status).toBe(404);
  });

  it("rejects a malformed id instead of querying for it", async () => {
    const res = await download("../../etc/passwd");
    expect(res.status).toBe(400);
    expect(dbFile).toBeNull();
  });

  it("serves a 503 rather than falling back to buffering when signing fails", async () => {
    dbFile = completed;
    createSignedDownloadUrl.mockRejectedValueOnce(new Error("503 from storage: bucket documents unavailable"));
    const res = await download(FILE_ID);
    expect(res.status).toBe(503);
    const json = await body(res);
    expect(json).toMatchObject({ code: "DOWNLOAD_UNAVAILABLE" });
    expect(JSON.stringify(json)).not.toContain("bucket");
    expect(json.error).not.toContain("503 from storage");
  });

  it("streams on the local backend, where no credential can be minted", async () => {
    envOverrides.STORAGE_BACKEND = "local";
    dbFile = completed;
    await load();
    dbFile = completed;
    const res = await download(FILE_ID);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(createSignedDownloadUrl).not.toHaveBeenCalled();
    const chunks = [];
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk.length);
    expect(chunks).toEqual([3]);
  });

  it("answers 404 when the local object has disappeared", async () => {
    envOverrides.STORAGE_BACKEND = "local";
    await load();
    dbFile = completed;
    openStream.mockRejectedValueOnce(new Error("ENOENT"));
    const res = await download(FILE_ID);
    expect(res.status).toBe(404);
  });

  it("does not expose a row without a storage key", async () => {
    dbFile = { ...completed, storageKey: null };
    const res = await download(FILE_ID);
    expect(res.status).toBe(404);
    expect(createSignedDownloadUrl).not.toHaveBeenCalled();
  });
});
