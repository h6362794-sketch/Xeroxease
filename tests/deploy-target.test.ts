// Deployment-target pin: a staging deployment must write only to its own Supabase project.
import { describe, it, expect } from "vitest";
import { evaluateDeployTarget, deployTargetInputFromEnv } from "@/server/deploy-target";

const STAGING = "abcdefghijklmnopqrst";
const OTHER = "zyxwvutsrqponmlkjihg";
const PASSWORD = "p4ss-w0rd-SECRET";

function staged(overrides: Partial<Parameters<typeof evaluateDeployTarget>[0]> = {}) {
  return {
    deployTarget: "staging",
    expectedProjectRef: STAGING,
    supabaseUrl: `https://${STAGING}.supabase.co`,
    databaseUrl: `postgresql://postgres.${STAGING}:${PASSWORD}@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres`,
    directUrl: `postgresql://postgres:${PASSWORD}@db.${STAGING}.supabase.co:5432/postgres`,
    ...overrides,
  };
}

describe("evaluateDeployTarget", () => {
  it("does nothing when neither variable is set", () => {
    expect(evaluateDeployTarget({ deployTarget: "", expectedProjectRef: "", supabaseUrl: "", databaseUrl: "", directUrl: "" })).toEqual({
      active: false,
      problems: [],
    });
  });

  it("passes when every URL belongs to the pinned project", () => {
    expect(evaluateDeployTarget(staged())).toEqual({ active: true, problems: [] });
  });

  it("requires a project ref for staging", () => {
    const r = evaluateDeployTarget(staged({ expectedProjectRef: "" }));
    expect(r.active).toBe(true);
    expect(r.problems.join(" ")).toContain("requires EXPECTED_SUPABASE_PROJECT_REF");
  });

  it("rejects an unknown target name", () => {
    const r = evaluateDeployTarget(staged({ deployTarget: "preview" }));
    expect(r.problems.join(" ")).toContain('"staging" or "production"');
  });

  it("rejects a malformed ref instead of matching loosely", () => {
    const r = evaluateDeployTarget(staged({ expectedProjectRef: "not-a-ref" }));
    expect(r.problems).toEqual(["EXPECTED_SUPABASE_PROJECT_REF must be the 20-character lowercase project ref."]);
  });

  it("catches a production database URL copied into staging, without printing it", () => {
    const r = evaluateDeployTarget(
      staged({
        databaseUrl: `postgresql://postgres.${OTHER}:${PASSWORD}@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres`,
      })
    );
    expect(r.problems).toEqual(["DATABASE_URL does not belong to EXPECTED_SUPABASE_PROJECT_REF."]);
    const text = r.problems.join(" ");
    expect(text).not.toContain(OTHER);
    expect(text).not.toContain(PASSWORD);
  });

  it("catches a mismatched Supabase URL and a mismatched direct URL", () => {
    const r = evaluateDeployTarget(
      staged({
        supabaseUrl: `https://${OTHER}.supabase.co`,
        directUrl: `postgresql://postgres:${PASSWORD}@db.${OTHER}.supabase.co:5432/postgres`,
      })
    );
    expect(r.problems).toEqual([
      "NEXT_PUBLIC_SUPABASE_URL does not point at EXPECTED_SUPABASE_PROJECT_REF.",
      "DIRECT_URL does not belong to EXPECTED_SUPABASE_PROJECT_REF.",
    ]);
  });

  it("does not accept look-alike hosts or usernames that merely contain the ref", () => {
    const lookalikes = [
      `postgresql://postgres:${PASSWORD}@db.${STAGING}.supabase.co.evil.example:5432/postgres`,
      `postgresql://postgres:${PASSWORD}@evil-${STAGING}.example.com:5432/postgres`,
      `postgresql://postgres.${STAGING}x:${PASSWORD}@aws-0.pooler.supabase.com:6543/postgres`,
      `postgresql://postgres.${OTHER}:${PASSWORD}@aws-0.pooler.supabase.com:6543/${STAGING}`,
    ];
    for (const url of lookalikes) {
      const r = evaluateDeployTarget(staged({ databaseUrl: url }));
      expect(r.problems, url).toEqual(["DATABASE_URL does not belong to EXPECTED_SUPABASE_PROJECT_REF."]);
    }
  });

  it("rejects a matching pooler username on another project's direct host", () => {
    const url = `postgresql://postgres.${STAGING}:${PASSWORD}@db.${OTHER}.supabase.co:5432/postgres`;
    const r = evaluateDeployTarget(staged({ databaseUrl: url, directUrl: url }));
    expect(r.problems).toEqual([
      "DATABASE_URL does not belong to EXPECTED_SUPABASE_PROJECT_REF.",
      "DIRECT_URL does not belong to EXPECTED_SUPABASE_PROJECT_REF.",
    ]);
  });

  it("rejects a matching pooler username on a host that is not Supabase", () => {
    const url = `postgresql://postgres.${STAGING}:${PASSWORD}@pooler.evil.example:6543/postgres`;
    expect(evaluateDeployTarget(staged({ databaseUrl: url })).problems).toEqual([
      "DATABASE_URL does not belong to EXPECTED_SUPABASE_PROJECT_REF.",
    ]);
  });

  it("rejects a pooler host whose username names another project", () => {
    const url = `postgresql://postgres.${OTHER}:${PASSWORD}@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres`;
    expect(evaluateDeployTarget(staged({ databaseUrl: url })).problems).toEqual([
      "DATABASE_URL does not belong to EXPECTED_SUPABASE_PROJECT_REF.",
    ]);
  });

  it("rejects another project named in the query string, even on this project's host", () => {
    const url = `postgresql://postgres.${STAGING}:${PASSWORD}@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres?options=reference%3D${OTHER}`;
    expect(evaluateDeployTarget(staged({ databaseUrl: url })).problems).toEqual([
      "DATABASE_URL does not belong to EXPECTED_SUPABASE_PROJECT_REF.",
    ]);
  });

  it("still accepts this project's pooler with ordinary connection options", () => {
    const url = `postgresql://postgres.${STAGING}:${PASSWORD}@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1&sslmode=require`;
    expect(evaluateDeployTarget(staged({ databaseUrl: url }))).toEqual({ active: true, problems: [] });
  });

  it("treats an unparseable URL as not belonging to the project", () => {
    const r = evaluateDeployTarget(staged({ databaseUrl: "not a url" }));
    expect(r.problems).toEqual(["DATABASE_URL does not belong to EXPECTED_SUPABASE_PROJECT_REF."]);
  });

  it("allows pinning production to its own project", () => {
    const r = evaluateDeployTarget(staged({ deployTarget: "production" }));
    expect(r).toEqual({ active: true, problems: [] });
  });
});

describe("deployTargetInputFromEnv", () => {
  it("reads and trims the guard variables", () => {
    const input = deployTargetInputFromEnv({
      DEPLOY_TARGET: " staging ",
      EXPECTED_SUPABASE_PROJECT_REF: `${STAGING} `,
      DATABASE_URL: "postgresql://x",
    } as unknown as NodeJS.ProcessEnv);
    expect(input.deployTarget).toBe("staging");
    expect(input.expectedProjectRef).toBe(STAGING);
    expect(input.supabaseUrl).toBe("");
  });
});
