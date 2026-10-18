#!/usr/bin/env node
// Fails the build unless a Vitest JSON report shows EXACTLY the expected number of tests, all passed.
//
// Usage: node scripts/assert-vitest-report.mjs <report.json> <expectedCount>
//
// Why: a step that runs a database-backed test file can pass while the file skipped every test.
// This gate reads the machine-readable report, so "the tests ran and passed" is proven by the step's
// own result, not by a log line a reader has to find. Skipped, todo, failed or missing tests fail it.

import { readFileSync } from "node:fs";

export function checkReport(report, expectedCount) {
  const problems = [];
  const assertions = (report.testResults ?? []).flatMap((f) => f.assertionResults ?? []);
  if (!Number.isInteger(expectedCount) || expectedCount < 1) {
    problems.push("expectedCount must be a positive integer");
  }
  if (report.numTotalTests !== expectedCount) problems.push(`numTotalTests=${report.numTotalTests}, expected ${expectedCount}`);
  if (report.numPassedTests !== expectedCount) problems.push(`numPassedTests=${report.numPassedTests}, expected ${expectedCount}`);
  if (report.numFailedTests !== 0) problems.push(`numFailedTests=${report.numFailedTests}`);
  if (report.numPendingTests !== 0) problems.push(`numPendingTests=${report.numPendingTests} (skipped)`);
  if (report.numTodoTests !== 0) problems.push(`numTodoTests=${report.numTodoTests}`);
  if (assertions.length !== expectedCount) problems.push(`report lists ${assertions.length} tests, expected ${expectedCount}`);
  const notPassed = assertions.filter((a) => a.status !== "passed");
  if (notPassed.length > 0) problems.push(`${notPassed.length} test(s) not passed: ${notPassed.map((a) => a.status).join(", ")}`);
  return problems;
}

function main() {
  const [file, expected] = process.argv.slice(2);
  let report;
  try {
    report = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`assert-vitest-report: cannot read ${file}: ${err.message}`);
    process.exit(1);
  }
  const problems = checkReport(report, Number(expected));
  if (problems.length > 0) {
    console.error(`assert-vitest-report: FAILED: ${problems.join("; ")}`);
    process.exit(1);
  }
  console.log(`assert-vitest-report: OK: ${report.numPassedTests} of ${expected} tests passed, 0 skipped, 0 failed.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
