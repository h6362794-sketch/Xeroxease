import { describe, it, expect } from "vitest";
// The gate is plain ESM with no dependencies, so the test imports it directly.
import { checkReport } from "../scripts/assert-vitest-report.mjs";

/** A report with `n` tests, all in one file, with the given status for each. */
function report(statuses: string[]) {
  const count = (s: string) => statuses.filter((x) => x === s).length;
  return {
    numTotalTests: statuses.length,
    numPassedTests: count("passed"),
    numFailedTests: count("failed"),
    numPendingTests: count("skipped") + count("pending"),
    numTodoTests: count("todo"),
    testResults: [{ assertionResults: statuses.map((status) => ({ status })) }],
  };
}

describe("the CI gate that proves the PostgreSQL race file ran", () => {
  it("passes when exactly the expected number of tests passed", () => {
    expect(checkReport(report(["passed", "passed", "passed"]), 3)).toEqual([]);
  });

  it("fails when every test was skipped (the silent-skip case)", () => {
    const problems = checkReport(report(["skipped", "skipped", "skipped"]), 3);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(" ")).toMatch(/skipped/);
  });

  it("fails when one test was skipped among passing ones", () => {
    expect(checkReport(report(["passed", "skipped", "passed"]), 3).length).toBeGreaterThan(0);
  });

  it("fails on a failing test", () => {
    expect(checkReport(report(["passed", "failed", "passed"]), 3).length).toBeGreaterThan(0);
  });

  it("fails when fewer tests exist than expected (a file that lost tests)", () => {
    expect(checkReport(report(["passed", "passed"]), 3).length).toBeGreaterThan(0);
  });

  it("fails when more tests exist than expected (count drift must be a conscious edit)", () => {
    expect(checkReport(report(["passed", "passed", "passed", "passed"]), 3).length).toBeGreaterThan(0);
  });

  it("fails on a todo test", () => {
    expect(checkReport(report(["passed", "todo", "passed"]), 3).length).toBeGreaterThan(0);
  });

  it("rejects a nonsense expected count", () => {
    expect(checkReport(report(["passed"]), 0).length).toBeGreaterThan(0);
  });
});
