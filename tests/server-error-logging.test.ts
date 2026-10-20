import { afterEach, expect, it, vi } from "vitest";
import { onRequestError } from "@/instrumentation";
afterEach(() => vi.restoreAllMocks());
it("joins the RSC digest to a safe server event without logging query/headers/messages", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const error = Object.assign(new Error("student secret SQL parameters"), {
    digest: "123456789", code: "P2022",
    stack: "Error: student secret SQL parameters\n    at DashboardPage (/app/dashboard.js:1:2)",
  });
  onRequestError(error, { path: "/dashboard?secret=token", method: "GET", headers: { cookie: "secret" } }, {
    routerKind: "App Router", routePath: "/dashboard", routeType: "render",
    renderSource: "react-server-components", revalidateReason: undefined,
  });
  const event = JSON.parse(log.mock.calls[0][1]);
  expect(event).toMatchObject({ digest: "123456789", code: "P2022", route: "/dashboard", routeType: "render" });
  expect(event.stack).toContain("at /app/dashboard.js:1:2");
  expect(JSON.stringify(event)).not.toMatch(/secret|SQL parameters|cookie/);
});

it("rejects message continuations, eval/query URLs and function display-name data in stack traces", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  onRequestError(Object.assign(new Error("secret"), {
    digest: "secret?token=123",
    stack: "Error: secret\n    at secret password\n    at eval (https://example.test/file.js?token=secret:1:2)\n    at studentSecret (/app/dashboard.js:3:4)",
  }), { path: "/dashboard", method: "GET", headers: { "x-vercel-id": "region::safe-id" } }, {
    routerKind: "App Router", routePath: "/dashboard", routeType: "render", revalidateReason: undefined,
  });
  const event = JSON.parse(log.mock.calls[0][1]);
  expect(event.requestId).toBe("region::safe-id");
  expect(event.stack).toBe("    at /app/dashboard.js:3:4");
  expect(event.digest).toBeUndefined();
  expect(JSON.stringify(event)).not.toMatch(/secret|studentSecret|token|password/i);
});
it("handles non-Error throws and rejects malformed correlation IDs without hiding the failure", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(() => onRequestError(null, { path: "/private", method: "GET", headers: { "x-vercel-id": "injected\nsecret" } }, {
    routerKind: "App Router", routePath: "/dashboard", routeType: "render", revalidateReason: undefined,
  })).not.toThrow();
  expect(log).toHaveBeenCalledTimes(1);
  expect(JSON.parse(log.mock.calls[0][1])).toMatchObject({ route: "/dashboard", routeType: "render" });
  expect(log.mock.calls[0][1]).not.toMatch(/injected|secret|private/);
});
it("removes the entire multiline Error message even when it forges a valid file frame", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  // Real V8 Error.stack repeats the full message before the captured frames.
  const error = new Error("request failed\n    at /app/studentSecret.js:1:2");
  onRequestError(error, { path: "/dashboard", method: "GET", headers: {} }, {
    routerKind: "App Router", routePath: "/dashboard", routeType: "render", revalidateReason: undefined,
  });
  const event = JSON.parse(log.mock.calls[0][1]);
  expect(event.stack).not.toContain("studentSecret");
  expect(event.stack).toContain("server-error-logging.test.ts");
});
