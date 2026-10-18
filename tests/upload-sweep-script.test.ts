// The scheduler's request script, run for real against a local stub that plays the app's role.
// Covers: what is refused before any request is sent; that the secret and target travel as
// headers; how each HTTP answer maps to an exit code; and that no secret is ever printed.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);
const SCRIPT = path.resolve(__dirname, "../scripts/run-upload-sweep.sh");
const SECRET = "scheduler-secret-0123456789abcdef-0123456789";
const PATH_OK = "/api/admin/uploads/sweep";
/** Placed in every response body. The script must never print it. */
const BODY_MARKER = "BODY-MARKER-do-not-print-7f3a";

interface Seen {
  method?: string;
  url?: string;
  auth?: string;
  target?: string;
}
let seen: Seen[] = [];
let bypassSeen: string[] = [];
let server: Server;
let port = 0;
/** What the stub app considers this deployment's target. */
let appTarget = "staging";
/** Stub behaviour switch: "ok" | "redirect" | "forbidden". */
let mode: "ok" | "redirect" | "forbidden" = "ok";

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    seen.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
      target: req.headers["x-deploy-target"] as string | undefined,
    });
    if (req.headers["x-vercel-protection-bypass"] !== undefined) {
      bypassSeen.push(req.headers["x-vercel-protection-bypass"] as string);
    }
    if (mode === "redirect") {
      res.writeHead(307, { Location: "/somewhere-else" });
      return res.end();
    }
    const authed = req.headers.authorization === `Bearer ${SECRET}`;
    const targetOk = req.headers["x-deploy-target"] === appTarget;
    if (mode === "forbidden" || !authed || !targetOk) {
      res.writeHead(403, { "content-type": "application/json" });
      return res.end(JSON.stringify({ code: "SCHEDULER_TARGET_MISMATCH", detail: BODY_MARKER }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ released: 0, attempted: 0, detail: BODY_MARKER }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function env(over: Record<string, string | undefined> = {}): Record<string, string> {
  const base: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    SWEEP_URL: `http://127.0.0.1:${port}${PATH_OK}`,
    SWEEP_EXPECTED_HOST: "127.0.0.1",
    SWEEP_TARGET: "staging",
    CRON_SECRET: SECRET,
    SWEEP_ALLOW_LOOPBACK_HTTP: "1",
    ...over,
  };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) out[k] = v;
  return out;
}

async function sweep(over: Record<string, string | undefined> = {}) {
  seen = [];
  try {
    const { stdout, stderr } = await run("bash", [SCRIPT], { env: env(over) as NodeJS.ProcessEnv, timeout: 20_000 });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : -1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

describe("run-upload-sweep.sh", () => {
  it("sends the secret and target as headers and exits 0 on a 2xx answer", async () => {
    mode = "ok";
    appTarget = "staging";
    const r = await sweep();
    expect(r.code).toBe(0);
    expect(r.out).toContain("HTTP 200");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", url: `${PATH_OK}?limit=50`, auth: `Bearer ${SECRET}`, target: "staging" });
    // The secret and the target are never printed, and neither is the response body.
    expect(r.out).not.toContain(SECRET);
    expect(r.out).not.toContain(BODY_MARKER);
  });

  it("sends the Vercel automation bypass as a header when one is configured, and never prints it", async () => {
    mode = "ok";
    appTarget = "staging";
    bypassSeen = [];
    const r = await sweep({ SWEEP_PROTECTION_BYPASS: "vercel-bypass-VALUE-0123456789" });
    expect(r.code).toBe(0);
    expect(bypassSeen).toEqual(["vercel-bypass-VALUE-0123456789"]);
    expect(r.out).not.toContain("vercel-bypass-VALUE");
  });

  it("sends no bypass header when none is configured", async () => {
    mode = "ok";
    bypassSeen = [];
    const r = await sweep();
    expect(r.code).toBe(0);
    expect(bypassSeen).toEqual([]);
  });

  it("exits 1 when the app refuses the scheduler (target mismatch)", async () => {
    mode = "ok";
    appTarget = "production"; // the receiving deployment is not this scheduler's target
    const r = await sweep();
    expect(r.code).toBe(1);
    expect(r.out).toContain("HTTP 403");
    expect(r.out).not.toContain(SECRET);
    appTarget = "staging";
  });

  it("exits 1 on a 307 and does not follow it (a redirect would hide the answer)", async () => {
    mode = "redirect";
    const r = await sweep();
    expect(r.code).toBe(1);
    expect(seen.map((s) => s.url)).toEqual([`${PATH_OK}?limit=50`]);
    mode = "ok";
  });

  it("refuses plain http to a remote host before sending anything", async () => {
    const r = await sweep({ SWEEP_URL: "http://example.com/api/admin/uploads/sweep", SWEEP_ALLOW_LOOPBACK_HTTP: "1" });
    expect(r.code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it("refuses loopback http unless the test harness allows it", async () => {
    const r = await sweep({ SWEEP_ALLOW_LOOPBACK_HTTP: undefined });
    expect(r.code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it("refuses any other path, so the scheduler cannot be pointed at a different endpoint", async () => {
    for (const bad of [
      "https://app.example.com/api/orders",
      "https://app.example.com/api/admin/uploads/sweep/extra",
      "https://app.example.com/api/admin/uploads/sweep?x=1",
    ]) {
      const r = await sweep({ SWEEP_URL: bad });
      expect(r.code, bad).toBe(2);
    }
    expect(seen).toHaveLength(0);
  });

  it("refuses a short scheduler secret before sending anything", async () => {
    const r = await sweep({ CRON_SECRET: "too-short" });
    expect(r.code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it("refuses an unknown SWEEP_TARGET", async () => {
    const r = await sweep({ SWEEP_TARGET: "preview" });
    expect(r.code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it("refuses an out-of-range limit", async () => {
    const r = await sweep({ SWEEP_LIMIT: "501" });
    expect(r.code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it("sends nothing to a host other than the approved one, even over https", async () => {
    // The approved host is 127.0.0.1, so this URL is a different, unreachable host. Validation
    // must refuse it (exit 2) before curl runs. A reached-but-failed request would exit 1.
    const r = await sweep({
      SWEEP_URL: "https://attacker.example.invalid/api/admin/uploads/sweep",
      SWEEP_ALLOW_LOOPBACK_HTTP: undefined,
    });
    expect(r.code).toBe(2);
    expect(r.out).toContain("Nothing was sent");
    expect(r.out).not.toContain(SECRET);
    expect(seen).toHaveLength(0);
  });

  it("matches the host exactly: a subdomain or suffix of the approved host is refused", async () => {
    for (const host of ["evil-127.0.0.1.example.invalid", "127.0.0.1.example.invalid", "xx127.0.0.1"]) {
      const r = await sweep({
        SWEEP_URL: `https://${host}/api/admin/uploads/sweep`,
        SWEEP_EXPECTED_HOST: "127.0.0.1",
        SWEEP_ALLOW_LOOPBACK_HTTP: undefined,
      });
      expect(r.code, host).toBe(2);
    }
    expect(seen).toHaveLength(0);
  });

  it("refuses a userinfo trick that puts the approved host before an @", async () => {
    const r = await sweep({
      SWEEP_URL: "https://127.0.0.1@attacker.example.invalid/api/admin/uploads/sweep",
      SWEEP_ALLOW_LOOPBACK_HTTP: undefined,
    });
    expect(r.code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it("refuses to run when no approved host is configured", async () => {
    const r = await sweep({ SWEEP_EXPECTED_HOST: undefined });
    expect(r.code).not.toBe(0);
    expect(seen).toHaveLength(0);
  });

  it("refuses an expected-host value that is not a bare hostname", async () => {
    for (const bad of ["https://127.0.0.1", "127.0.0.1:8080", "*.example.com"]) {
      const r = await sweep({ SWEEP_EXPECTED_HOST: bad });
      expect(r.code, bad).toBe(2);
    }
    expect(seen).toHaveLength(0);
  });

  it("requires every input to be set", async () => {
    const r = await sweep({ CRON_SECRET: undefined });
    expect(r.code).not.toBe(0);
    expect(seen).toHaveLength(0);
  });
});
