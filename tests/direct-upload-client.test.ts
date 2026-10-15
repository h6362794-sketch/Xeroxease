// Browser side of the direct upload protocol.
//
// These tests pin the *client's judgement calls*: when to attempt a direct PUT, when to
// fall back to the proxy route, and when to hand the file slot back. They are worth
// pinning because each of those decisions is a user-visible failure mode if it drifts
// (a dead drop zone, a re-uploaded 100 MB file, or a slot held by a dead intent).

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  chooseUploadMode,
  exceedsUploadLimit,
  isUnsupportedDeployment,
  putToStorage,
  shouldReleaseIntentAfterFailure,
  uploadDocumentDirect,
  type UploadCapability,
  type UploadIntent,
} from "@/lib/direct-upload";

const MB = 1024 * 1024;

/** The bits of `AbortSignal` the code under test touches, left mutable for assertions. */
interface TestSignal {
  aborted: boolean;
  addEventListener(type: string, fn: () => void): void;
}

/** An error the client throws, typed as it shapes it. */
type ClientError = Error & { code: string; status?: number };

/**
 * Awaits a promise that must reject and hands the rejection back typed as `ClientError`.
 * (`catch`-ing inline would type the result as `void | ClientError`, because the handler's
 * return value joins the resolved type.)
 */
async function rejection(promise: Promise<unknown>): Promise<ClientError> {
  try {
    await promise;
  } catch (err) {
    return err as ClientError;
  }
  throw new Error("expected the promise to reject");
}

describe("chooseUploadMode", () => {
  it("uses the direct path only when the deployment says it can", () => {
    const on: UploadCapability = { enabled: true, maxBytes: 100 * MB, proxyUploadAvailable: false };
    expect(chooseUploadMode(on)).toBe("direct");
  });

  it("falls back to proxy for a disabled or unsupported deployment", () => {
    expect(chooseUploadMode({ enabled: false, code: "BACKEND_UNSUPPORTED", reason: "local" })).toBe("proxy");
    expect(chooseUploadMode({ enabled: false, code: "DISABLED" })).toBe("proxy");
    expect(chooseUploadMode({ enabled: false })).toBe("proxy");
  });

  it("never leaves the UI dead when the probe is missing, malformed or thrown", () => {
    expect(chooseUploadMode(null)).toBe("proxy");
    expect(chooseUploadMode(undefined)).toBe("proxy");
    expect(chooseUploadMode({} as UploadCapability)).toBe("proxy");
    // A truthy-but-odd payload must not be read as an endorsement.
    expect(chooseUploadMode({ enabled: "yes" } as unknown as UploadCapability)).toBe("proxy");
  });
});

describe("exceedsUploadLimit", () => {
  it("is inclusive at the boundary and strict above it", () => {
    expect(exceedsUploadLimit(100 * MB, 100 * MB)).toBe(false);
    expect(exceedsUploadLimit(100 * MB + 1, 100 * MB)).toBe(true);
  });

  it("treats a zero-byte or non-finite size as over the limit", () => {
    expect(exceedsUploadLimit(0, 100 * MB)).toBe(true);
    expect(exceedsUploadLimit(-1, 100 * MB)).toBe(true);
    expect(exceedsUploadLimit(NaN, 100 * MB)).toBe(true);
    expect(exceedsUploadLimit(Infinity, 100 * MB)).toBe(true);
  });

  it("honours a lower provider cap", () => {
    expect(exceedsUploadLimit(60 * MB, 50 * MB)).toBe(true);
    expect(exceedsUploadLimit(49 * MB, 50 * MB)).toBe(false);
  });
});

describe("isUnsupportedDeployment", () => {
  it("recognises the deployment-shape answers worth retrying through the proxy", () => {
    expect(isUnsupportedDeployment(Object.assign(new Error("nope"), { status: 501, code: "BACKEND_UNSUPPORTED" }))).toBe(true);
    expect(isUnsupportedDeployment(Object.assign(new Error("nope"), { status: 501, code: "DIRECT_UPLOAD_UNSUPPORTED" }))).toBe(true);
    expect(isUnsupportedDeployment(Object.assign(new Error("nope"), { status: 503, code: "DISABLED" }))).toBe(true);
    expect(isUnsupportedDeployment(Object.assign(new Error("nope"), { status: 503, code: "SUPABASE_UNCONFIGURED" }))).toBe(true);
  });

  it("does not treat a real failure as a deployment clue", () => {
    for (const [status, code] of [
      [401, "UNAUTHENTICATED"], // session gone: the proxy route needs it too
      [403, "FORBIDDEN"],
      [409, "QUOTA"], // file slot full: a second upload makes it worse
      [413, "TOO_LARGE"], // the same limit applies on both paths
      [422, "SIGNATURE_MISMATCH"],
      [500, undefined],
      [502, undefined], // an upstream outage is not "unsupported"
    ] as const) {
      expect(isUnsupportedDeployment(Object.assign(new Error("x"), { status, code }))).toBe(false);
    }
  });

  it("ignores a 501/503 that carries an unrelated code", () => {
    expect(isUnsupportedDeployment(Object.assign(new Error("x"), { status: 503, code: "STORAGE_UNAVAILABLE" }))).toBe(false);
  });

  it("survives non-error throwables", () => {
    expect(isUnsupportedDeployment(undefined)).toBe(false);
    expect(isUnsupportedDeployment("501")).toBe(false);
    expect(isUnsupportedDeployment(new Error("network down"))).toBe(false);
  });
});

describe("shouldReleaseIntentAfterFailure", () => {
  it("releases when completion proved the object unusable", () => {
    for (const code of ["SIZE_MISMATCH", "SIGNATURE_MISMATCH", "TOKEN_MISMATCH", "TOKEN_INVALID"]) {
      expect(shouldReleaseIntentAfterFailure({ code })).toBe(true);
    }
  });

  it("keeps the intent live when a retry could reuse the bytes", () => {
    // Releasing here would throw away a completed 100 MB transfer.
    for (const code of ["STORAGE_UNAVAILABLE", "OBJECT_MISSING", "PERSIST_FAILED", "TIMEOUT", "ABORTED", "STORAGE_UNREACHABLE"]) {
      expect(shouldReleaseIntentAfterFailure({ code })).toBe(false);
    }
    expect(shouldReleaseIntentAfterFailure(undefined)).toBe(false);
    expect(shouldReleaseIntentAfterFailure(new Error("boom"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// putToStorage — one fake XHR, because the value of this function *is* its plumbing
// ---------------------------------------------------------------------------

class FakeXHR {
  static last: FakeXHR | null = null;
  method = "";
  url = "";
  headers: Record<string, string> = {};
  sent: unknown = null;
  status = 0;
  aborted = false;
  upload: { onprogress?: (event: unknown) => void } = {};
  onload?: () => void;
  onerror?: () => void;
  ontimeout?: () => void;
  onabort?: () => void;
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  abort() {
    this.aborted = true;
  }
  send(body: unknown) {
    this.sent = body;
    FakeXHR.last = this;
  }
  fireLoad(status: number) {
    this.status = status;
    this.onload?.();
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function useXhr(ctor: unknown) {
  (globalThis as any).XMLHttpRequest = ctor;
}

describe("putToStorage", () => {
  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).XMLHttpRequest;
    FakeXHR.last = null;
  });

  function install() {
    useXhr(FakeXHR);
    return () => FakeXHR.last as FakeXHR;
  }

  it("sends a bare PUT of the file with no credential of ours in it", async () => {
    const last = install();
    const blob = { name: "file" } as unknown as Blob;
    const p = putToStorage("https://host/storage/v1/object/sign/documents/a.pdf?token=provider", blob);
    last().fireLoad(200);
    await expect(p).resolves.toBeUndefined();
    const xhr = last();
    expect(xhr.method).toBe("PUT");
    expect(xhr.sent).toBe(blob);
    // The signed URL carries the provider's token; we add no Authorization header, which
    // is what keeps this a CORS-simple request.
    expect(xhr.headers.Authorization).toBeUndefined();
    expect(Object.keys(xhr.headers)).toEqual(["Content-Type"]);
  });

  it("reports progress as a fraction capped at 1", async () => {
    install();
    const onProgress = vi.fn();
    const p = putToStorage("https://host/x", {} as unknown as Blob, { onProgress });
    FakeXHR.last!.upload.onprogress?.({ lengthComputable: true, loaded: 500, total: 1000 });
    FakeXHR.last!.upload.onprogress?.({ lengthComputable: true, loaded: 2000, total: 1000 });
    FakeXHR.last!.upload.onprogress?.({ lengthComputable: false, loaded: 1, total: 0 });
    FakeXHR.last!.fireLoad(201);
    await p;
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress.mock.calls.map((c) => c[0])).toEqual([0.5, 1]);
  });

  it("maps a provider conflict to a distinct, retryable message", async () => {
    install();
    const p = putToStorage("https://host/x", {} as unknown as Blob);
    FakeXHR.last!.fireLoad(409);
    const err = await rejection(p);
    expect(err).toMatchObject({ code: "ALREADY_UPLOADED", status: 409 });
    expect(err.message).toContain("already uploaded");
  });

  it("maps any other failure status to STORAGE_PUT_FAILED", async () => {
    install();
    const p = putToStorage("https://host/x", {} as unknown as Blob);
    FakeXHR.last!.fireLoad(400);
    const err = await rejection(p);
    expect(err).toMatchObject({ code: "STORAGE_PUT_FAILED", status: 400 });
    // Never leak a provider response body into the UI.
    expect(err.message).toBe("The storage service rejected the upload (400).");
  });

  it("distinguishes an unreachable storage host from a rejection", async () => {
    install();
    const p = putToStorage("https://host/x", {} as unknown as Blob);
    FakeXHR.last!.onerror?.();
    const err = await rejection(p);
    expect(err.code).toBe("STORAGE_UNREACHABLE");
    expect(err.message).toContain("was not uploaded");
  });

  it("times out loudly instead of hanging the wizard", async () => {
    install();
    const p = putToStorage("https://host/x", {} as unknown as Blob);
    FakeXHR.last!.ontimeout?.();
    expect((await rejection(p)).code).toBe("TIMEOUT");
  });

  it("aborts when the caller's signal fires, and never sends at all if already aborted", async () => {
    install();
    const listeners: Array<() => void> = [];
    const signal: TestSignal = {
      aborted: false,
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
    };
    const p = putToStorage("https://host/x", {} as unknown as Blob, {
      signal: signal as unknown as AbortSignal,
    });
    expect(FakeXHR.last).not.toBeNull(); // send() was called
    signal.aborted = true;
    listeners.forEach((fn) => fn());
    expect(FakeXHR.last!.aborted).toBe(true);
    FakeXHR.last!.onabort?.();
    expect((await rejection(p)).code).toBe("ABORTED");

    // Already cancelled before we started: no request leaves the browser.
    class ExplodingXHR extends FakeXHR {
      send() {
        throw new Error("send() must not be called for an aborted upload");
      }
    }
    useXhr(ExplodingXHR);
    FakeXHR.last = null;
    const pre = putToStorage("https://host/x", {} as unknown as Blob, {
      signal: { aborted: true, addEventListener: () => undefined } as TestSignal as unknown as AbortSignal,
    });
    expect((await rejection(pre)).code).toBe("ABORTED");
  });
});

// ---------------------------------------------------------------------------
// uploadDocumentDirect — the ordering that keeps state consistent
// ---------------------------------------------------------------------------

function intent(over: Partial<UploadIntent> = {}): UploadIntent {
  return {
    fileId: "file-1",
    token: "v1.payload.signature",
    uploadUrl: "https://host/storage/signed?token=provider",
    method: "PUT",
    headers: {},
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    maxBytes: 100 * MB,
    proxyUploadAvailable: false,
    fileSizeLimitNote: null,
    ...over,
  };
}

/** Auto-resolving XHR: every PUT "succeeds" (or fails) without test-side firing. */
function installXhr(status: number, event: "load" | "error" = "load") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).XMLHttpRequest = class {
    upload: { onprogress?: (e: unknown) => void } = {};
    onload?: () => void;
    onerror?: () => void;
    ontimeout?: () => void;
    onabort?: () => void;
    status = 0;
    open() {}
    setRequestHeader() {}
    abort() {}
    send() {
      if (event === "error") {
        queueMicrotask(() => this.onerror?.());
        return;
      }
      queueMicrotask(() => {
        this.status = status;
        this.onload?.();
      });
    }
  };
}

function uploadFile(): File {
  return { name: "notes.pdf", type: "application/pdf", size: 42 } as unknown as File;
}

type Mock = ReturnType<typeof vi.fn>;

function makeDeps(over: { requestIntent?: Mock; reportComplete?: Mock; releaseIntent?: Mock } = {}) {
  return {
    requestIntent: over.requestIntent ?? vi.fn(async () => intent()),
    reportComplete: over.reportComplete ?? vi.fn(async () => ({ file: { id: "file-1", sizeBytes: 42 } })),
    releaseIntent: over.releaseIntent ?? vi.fn(async () => undefined),
  };
}

function run(file: File, deps: ReturnType<typeof makeDeps>) {
  return uploadDocumentDirect(file, deps as unknown as Parameters<typeof uploadDocumentDirect>[1]);
}

describe("uploadDocumentDirect", () => {
  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).XMLHttpRequest;
  });

  it("asks for an intent, uploads, then reports completion with the one-use token", async () => {
    installXhr(200);
    const d = makeDeps();
    const res = await run(uploadFile(), d);
    expect(res.fileId).toBe("file-1");
    expect(d.requestIntent).toHaveBeenCalledWith({ filename: "notes.pdf", mimeType: "application/pdf", sizeBytes: 42 });
    expect(d.reportComplete).toHaveBeenCalledWith({ fileId: "file-1", token: "v1.payload.signature" });
    expect(d.releaseIntent).not.toHaveBeenCalled();
  });

  it("releases the intent only when the object was proved unusable", async () => {
    installXhr(200);
    for (const [code, releases] of [
      ["SIZE_MISMATCH", true],
      ["SIGNATURE_MISMATCH", true],
      ["TOKEN_MISMATCH", true],
      ["OBJECT_MISSING", false],
      ["STORAGE_UNAVAILABLE", false],
      ["EXPIRED", false],
    ] as const) {
      const d = makeDeps({
        reportComplete: vi.fn(async () => {
          throw Object.assign(new Error("server said no"), { code });
        }),
      });
      const err = await rejection(run(uploadFile(), d));
      expect(err.code).toBe(code);
      expect(d.releaseIntent.mock.calls.length, code).toBe(releases ? 1 : 0);
    }
  });

  it("does not release the intent when the bytes never left the browser", async () => {
    installXhr(0, "error");
    const d = makeDeps();
    const err = await rejection(run(uploadFile(), d));
    expect(err.code).toBe("STORAGE_UNREACHABLE");
    // Nothing was stored, so there is nothing to delete — and completion was never
    // attempted, so the row is still a live intent the user can retry against.
    expect(d.reportComplete).not.toHaveBeenCalled();
    expect(d.releaseIntent).not.toHaveBeenCalled();
  });

  it("propagates the intent failure and never contacts storage", async () => {
    const d = makeDeps({
      requestIntent: vi.fn(async () => {
        throw Object.assign(new Error("File exceeds the 100 MB limit."), { status: 413, code: "TOO_LARGE" });
      }),
    });
    const err = await rejection(run(uploadFile(), d));
    expect(err).toMatchObject({ status: 413, code: "TOO_LARGE" });
    expect(d.reportComplete).not.toHaveBeenCalled();
    expect(d.releaseIntent).not.toHaveBeenCalled();
  });

  it("surfaces the upload failure even when releasing the intent also fails", async () => {
    installXhr(200);
    const d = makeDeps({
      reportComplete: vi.fn(async () => {
        throw Object.assign(new Error("The uploaded file does not match the declared size."), { code: "SIZE_MISMATCH" });
      }),
      releaseIntent: vi.fn(async () => {
        throw new Error("abort endpoint exploded");
      }),
    });
    const err = await rejection(run(uploadFile(), d));
    // The cleanup failure is swallowed: the user must see the real reason, and the
    // expiry sweep is the backstop for the abandoned intent.
    expect(err.code).toBe("SIZE_MISMATCH");
    expect(err.message).not.toContain("exploded");
    expect(d.releaseIntent).toHaveBeenCalledWith("file-1");
  });

  it("hands the completion response back to the caller untouched", async () => {
    installXhr(200);
    const complete = { file: { id: "file-1", originalName: "notes.pdf", sizeBytes: 4096 } };
    const d = makeDeps({ reportComplete: vi.fn(async () => complete) });
    const res = await run(uploadFile(), d);
    // The wizard builds its file row from this (server-measured) payload, not from File.
    expect(res.complete).toEqual(complete);
  });
});
