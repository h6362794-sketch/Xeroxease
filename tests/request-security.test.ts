// Tests for request-level security helpers:
//   1. `getClientIp` — which header entry identifies a client for rate limiting.
//   2. `boundedBody` / `parseBoundedFormData` — the byte cap that stops an upload
//      from being fully buffered before its size is checked.
//
// Both test the real implementation. The only stubs are `src/server/env.ts` (so
// TRUSTED_PROXY_COUNT can be varied) and the Prisma client (so importing the API
// helper module does not need a database).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  boundedBody,
  parseBoundedFormData,
  UploadTooLargeError,
} from "@/lib/bounded-body";

// ---------------------------------------------------------------------------
// Part 1 — client IP resolution (rate-limit identity)
// ---------------------------------------------------------------------------

describe("getClientIp", () => {
  let trustedProxyCount = 1;
  let getClientIp: typeof import("@/server/api-utils").getClientIp;

  beforeEach(async () => {
    trustedProxyCount = 1;
    vi.resetModules();
    vi.doMock("@/server/env", () => ({
      env: {
        get TRUSTED_PROXY_COUNT() {
          return trustedProxyCount;
        },
        get SESSION_SECRET() {
          return "x".repeat(40);
        },
        get RATE_LIMIT_STORAGE() {
          return "memory";
        },
        get UPSTASH_REDIS_REST_URL() {
          return "";
        },
        get UPSTASH_REDIS_REST_TOKEN() {
          return "";
        },
        get RATE_LIMIT_FAIL_OPEN() {
          return false;
        },
      },
    }));
    ({ getClientIp } = await import("@/server/api-utils"));
  });

  afterEach(() => {
    vi.doUnmock("@/server/env");
  });

  function req(headers: Record<string, string>) {
    return new Request("https://example.test/api", { headers });
  }

  it("reads the entry written by the trusted proxy, not the leftmost entry", () => {
    // A client can prepend anything it likes to X-Forwarded-For. Taking the
    // leftmost entry let any client pick its own rate-limit bucket.
    expect(getClientIp(req({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("ignores forged prefixes however many the client adds", () => {
    expect(getClientIp(req({ "x-forwarded-for": "9.9.9.9, 8.8.8.8, 203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("honours a two-hop trusted proxy chain", () => {
    trustedProxyCount = 2;
    expect(getClientIp(req({ "x-forwarded-for": "9.9.9.9, 8.8.8.8, 203.0.113.9" }))).toBe("8.8.8.8");
  });

  it("falls back to the leftmost entry when the chain is shorter than the hop count", () => {
    trustedProxyCount = 3;
    expect(getClientIp(req({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("ignores X-Forwarded-For entirely when the app is directly exposed", () => {
    trustedProxyCount = 0;
    // x-real-ip is not consulted when TRUSTED_PROXY_COUNT is 0: nothing in the
    // request is trustworthy, so every client shares the "unknown" bucket.
    expect(getClientIp(req({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "203.0.113.9" }))).toBe("unknown");
  });

  it("falls back to x-real-ip when XFF is absent", () => {
    expect(getClientIp(req({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("returns 'unknown' when there is no usable header", () => {
    expect(getClientIp(req({}))).toBe("unknown");
  });

  it("tolerates empty and whitespace-only entries", () => {
    expect(getClientIp(req({ "x-forwarded-for": " , 203.0.113.9 , " }))).toBe("203.0.113.9");
  });
});

// ---------------------------------------------------------------------------
// Part 2 — bounded multipart body (upload size cap)
// ---------------------------------------------------------------------------

describe("boundedBody", () => {
  function stream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });
  }

  function multipartRequest(payload: Uint8Array, declaredLength?: number): Request {
    const boundary = "----xeroxeaseTestBoundary";
    const head = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="notes.txt"\r\n` +
        `Content-Type: text/plain\r\n\r\n`
    );
    const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
    const body = new Uint8Array(head.length + payload.length + tail.length);
    body.set(head, 0);
    body.set(payload, head.length);
    body.set(tail, head.length + payload.length);

    const headers: Record<string, string> = {
      "content-type": `multipart/form-data; boundary=${boundary}`,
    };
    if (declaredLength !== undefined) headers["content-length"] = String(declaredLength);

    return new Request("https://example.test/api/uploads", {
      method: "POST",
      body: stream([body]),
      // @ts-expect-error duplex is required by undici for a streaming request body
      duplex: "half",
      headers,
    });
  }

  it("passes a body that fits inside the cap", async () => {
    const bounded = boundedBody(stream([new Uint8Array(100)]), 1000);
    const buf = await new Response(bounded).arrayBuffer();
    expect(buf.byteLength).toBe(100);
  });

  it("aborts as soon as the cap is exceeded, without delivering the whole body", async () => {
    // 10 x 1 KB = 10 KB offered, capped at 2 KB.
    const chunks = Array.from({ length: 10 }, () => new Uint8Array(1024));
    const bounded = boundedBody(stream(chunks), 2048);

    let delivered = 0;
    const reader = bounded.getReader();
    await expect(
      (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          delivered += value.byteLength;
        }
      })()
    ).rejects.toBeInstanceOf(UploadTooLargeError);

    // The decisive property: only a bounded amount was ever delivered before the
    // stream errored, so the server never buffers the full payload.
    expect(delivered).toBeLessThanOrEqual(2048);
  });

  it("errors immediately for a zero-byte cap", async () => {
    const bounded = boundedBody(stream([new Uint8Array(10)]), 0);
    const reader = bounded.getReader();
    await expect(
      (async () => {
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      })()
    ).rejects.toBeInstanceOf(UploadTooLargeError);
  });

  describe("parseBoundedFormData", () => {
    it("parses a valid multipart body under the cap", async () => {
      const payload = new Uint8Array(2048).fill(65); // 2 KB of 'A'
      const form = await parseBoundedFormData(multipartRequest(payload), 1_000_000);
      const file = form.get("file") as File;
      expect(file).toBeInstanceOf(File);
      expect(file.name).toBe("notes.txt");
      expect(file.size).toBe(2048);
    });

    it("rejects a body that exceeds the cap while streaming", async () => {
      // 5 MB payload, 1 MB cap.
      const payload = new Uint8Array(5 * 1024 * 1024).fill(66);
      await expect(parseBoundedFormData(multipartRequest(payload), 1024 * 1024)).rejects.toBeInstanceOf(
        UploadTooLargeError
      );
    });

    it("still rejects an oversized body when Content-Length lies about the size", async () => {
      // The declared length says 42 bytes; the real body is 5 MB. A handler that
      // trusted Content-Length and checked size only after formData() resolved
      // would have buffered all 5 MB first.
      const payload = new Uint8Array(5 * 1024 * 1024).fill(67);
      await expect(
        parseBoundedFormData(multipartRequest(payload, /* declared */ 42), 1024 * 1024)
      ).rejects.toBeInstanceOf(UploadTooLargeError);
    });
  });
});
