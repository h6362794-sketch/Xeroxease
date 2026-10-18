import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Finding 7: the shared Upstash store must use a supported endpoint, and with
 * RATE_LIMIT_FAIL_OPEN=false every store failure must refuse the request. HTTP errors, transport
 * errors, malformed replies and per-command errors are all failures, never a count of zero.
 */

const cfg = vi.hoisted(() => ({
  RATE_LIMIT_STORAGE: "redis" as "redis" | "memory",
  UPSTASH_REDIS_REST_URL: "https://example-upstash.invalid/",
  UPSTASH_REDIS_REST_TOKEN: "test-token-not-real",
  RATE_LIMIT_FAIL_OPEN: false,
}));

vi.mock("@/server/env", () => ({ env: cfg }));

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[] = [];
let respond: () => Promise<Response> | Response;

const LIMIT = 5;
const WINDOW_MS = 60_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function check() {
  const { rateLimitAsync } = await import("@/server/rate-limit");
  return rateLimitAsync("test-key", LIMIT, WINDOW_MS);
}

beforeEach(() => {
  calls = [];
  cfg.RATE_LIMIT_STORAGE = "redis";
  cfg.RATE_LIMIT_FAIL_OPEN = false;
  cfg.UPSTASH_REDIS_REST_URL = "https://example-upstash.invalid/";
  // Restore the token too: the "credentials are missing" test empties it, and a leaked empty token
  // made every later test fail closed before fetch was called.
  cfg.UPSTASH_REDIS_REST_TOKEN = "test-token-not-real";
  respond = () => json([{ result: 1 }, { result: 1 }, { result: 60 }]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond();
    })
  );
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Upstash REST endpoint", () => {
  it("posts the transaction to /multi-exec on the configured base, with no double slash", async () => {
    const r = await check();
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://example-upstash.invalid/multi-exec");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual([
      ["INCR", "xe:rl:test-key"],
      ["EXPIRE", "xe:rl:test-key", 60, "NX"],
      ["TTL", "xe:rl:test-key"],
    ]);
  });

  it("sends the token as a bearer header, not in the URL", async () => {
    await check();
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token-not-real");
    expect(calls[0].url).not.toContain("test-token-not-real");
  });

  it("refuses a request over the limit and reports the TTL as retry-after", async () => {
    respond = () => json([{ result: LIMIT + 1 }, { result: 1 }, { result: 42 }]);
    const r = await check();
    expect(r).toMatchObject({ ok: false, retryAfterSec: 42 });
  });
});

describe("store failures with RATE_LIMIT_FAIL_OPEN=false refuse the request", () => {
  it.each([
    ["HTTP 500", () => new Response("internal body that must not be logged", { status: 500 })],
    ["HTTP 401", () => new Response("", { status: 401 })],
    ["HTTP 400", () => new Response("", { status: 400 })],
    ["a transport error", () => Promise.reject(new TypeError("fetch failed"))],
    ["a non-JSON 200", () => new Response("<html>gateway</html>", { status: 200 })],
    ["a single discarded-transaction error", () => json({ error: "ERR syntax error" })],
    ["a per-command error inside a 200", () => json([{ result: 1 }, { error: "ERR wrong type" }, { result: 60 }])],
    ["a missing result", () => json([{ result: 1 }, {}, { result: 60 }])],
    ["a short reply", () => json([{ result: 1 }])],
    ["a non-numeric count", () => json([{ result: "abc" }, { result: 1 }, { result: 60 }])],
  ])("refuses on %s", async (_label, make) => {
    respond = make as () => Response;
    const r = await check();
    expect(r.ok).toBe(false);
    expect(r.retryAfterSec).toBeGreaterThan(0);
  });

  it("does not log the response body or the token when the store fails", async () => {
    respond = () => new Response("secret-body-content", { status: 500 });
    await check();
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain("secret-body-content");
    expect(logged).not.toContain("test-token-not-real");
  });

  it("refuses when credentials are missing", async () => {
    cfg.UPSTASH_REDIS_REST_TOKEN = "";
    const r = await check();
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("store failures with RATE_LIMIT_FAIL_OPEN=true are an explicit opt-out", () => {
  it("allows the request on an HTTP error when the operator has opted out", async () => {
    cfg.RATE_LIMIT_FAIL_OPEN = true;
    respond = () => new Response("", { status: 503 });
    const r = await check();
    expect(r.ok).toBe(true);
  });
});

describe("store failure modes not covered above (mocked transport only)", () => {
  it("refuses when the request times out (AbortSignal.timeout rejects with a TimeoutError)", async () => {
    respond = () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const r = await check();
    expect(r.ok).toBe(false);
    expect(r.retryAfterSec).toBeGreaterThan(0);
    // The request carries a timeout signal, so a hung store cannot hold a request open forever.
    expect(calls[0].init.signal).toBeDefined();
  });

  it("refuses a 200 whose body is a JSON object rather than the transaction array", async () => {
    respond = () => json({ result: [1, 1, 60] });
    const r = await check();
    expect(r.ok).toBe(false);
  });

  it("refuses a 200 whose body is JSON null", async () => {
    respond = () => json(null);
    const r = await check();
    expect(r.ok).toBe(false);
  });

  it("never logs a transport error message, which may echo the request URL or token", async () => {
    respond = () => Promise.reject(new TypeError("fetch failed for test-token-not-real at example-upstash.invalid"));
    await check();
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain("test-token-not-real");
    expect(logged).not.toContain("example-upstash.invalid");
  });

  it("allows a request that lands exactly on the limit, and refuses the next one", async () => {
    respond = () => json([{ result: LIMIT }, { result: 1 }, { result: 60 }]);
    expect((await check()).ok).toBe(true);
    respond = () => json([{ result: LIMIT + 1 }, { result: 1 }, { result: 60 }]);
    expect((await check()).ok).toBe(false);
  });

  it("falls back to the window length when the TTL reply is not a positive number", async () => {
    respond = () => json([{ result: 1 }, { result: 1 }, { result: -1 }]);
    const r = await check();
    expect(r.ok).toBe(true);
    respond = () => json([{ result: LIMIT + 1 }, { result: 1 }, { result: -1 }]);
    expect(await check()).toMatchObject({ ok: false, retryAfterSec: 60 });
  });

  it("with RATE_LIMIT_FAIL_OPEN=true, a malformed reply is an explicit opt-out and is allowed", async () => {
    cfg.RATE_LIMIT_FAIL_OPEN = true;
    respond = () => json({ result: "not an array" });
    expect((await check()).ok).toBe(true);
  });
});
