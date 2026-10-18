// Static checks on .github/workflows/upload-sweep.yml. The workflow cannot be run here, so these
// tests pin the properties that keep it staging-only: it runs in the `staging` environment, it is
// gated on SWEEP_ENABLED, it refuses any target other than "staging" before a request is made, and
// no executable line names production. The server-side half (a production app refusing a staging
// header) is covered in direct-upload-routes.test.ts.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const WORKFLOW = path.resolve(__dirname, "../.github/workflows/upload-sweep.yml");
const text = readFileSync(WORKFLOW, "utf8");

// Lines that are executed or read by Actions (not YAML comments).
const code = text
  .split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");

describe("upload-sweep workflow stays on staging", () => {
  it("runs only in the staging GitHub environment", () => {
    expect(code).toMatch(/environment:\s*staging\s*$/m);
    expect(code).not.toMatch(/environment:\s*production/);
  });

  it("keeps scheduler execution deferred: the job needs SWEEP_ENABLED for every trigger, manual included", () => {
    // Owner decision: scheduler execution stays off until the retention review is complete. A manual
    // "Run workflow" must not be a back door around that, so the variable gates the job itself.
    expect(code).toMatch(/if:\s*vars\.SWEEP_ENABLED\s*==\s*'true'\s*$/m);
    expect(code).not.toMatch(/workflow_dispatch'\s*\|\|/);
  });

  it("refuses any SWEEP_TARGET other than staging before it sends a request", () => {
    const guard = code.indexOf('"${SWEEP_TARGET}" != "staging"');
    const send = code.indexOf("bash scripts/run-upload-sweep.sh");
    expect(guard).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(guard);
    // The guard must exit non-zero, not just print.
    const block = code.slice(guard, send);
    expect(block).toMatch(/exit 1/);
  });

  it("passes the approved staging host into the script, from the staging environment only", () => {
    expect(code).toMatch(/SWEEP_EXPECTED_HOST:\s*\$\{\{\s*vars\.SWEEP_EXPECTED_HOST\s*\}\}/);
    // It must be a variable, not a literal, so the owner approves the host in the environment.
    expect(code).not.toMatch(/SWEEP_EXPECTED_HOST:\s*(?!\$\{\{)\S/);
  });

  it("names no production host, target or production secret in executable lines", () => {
    expect(code).not.toMatch(/production/i);
    expect(code).not.toMatch(/PROD/);
  });

  it("is triggered only by the schedule and by a manual run", () => {
    const on = code.slice(code.indexOf("on:"), code.indexOf("permissions:"));
    expect(on).toMatch(/schedule:/);
    expect(on).toMatch(/workflow_dispatch:/);
    expect(on).not.toMatch(/pull_request|push:/);
  });

  it("reads only staging-scoped inputs and grants read-only repository permissions", () => {
    expect(code).toMatch(/permissions:\s*\n\s*contents:\s*read/);
    const secrets = [...code.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]);
    expect(new Set(secrets)).toEqual(new Set(["CRON_SECRET", "SWEEP_PROTECTION_BYPASS"]));
  });
});
