// Bounded-concurrency helper used by multi-query read paths.

import { describe, it, expect } from "vitest";
import { DB_QUERY_CONCURRENCY, runWithDbConcurrency } from "@/server/db-concurrency";

function deferred<T>(value: T, delayMs = 5) {
  return () =>
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(value), delayMs);
    });
}

describe("runWithDbConcurrency", () => {
  it("preserves results in tuple order", async () => {
    const results = await runWithDbConcurrency([
      deferred("first"),
      deferred("second"),
      deferred("third"),
    ]);
    expect(results).toEqual(["first", "second", "third"]);
  });

  it("never starts more tasks than the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const task = () => async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 3));
      inFlight -= 1;
      return "done";
    };

    const tasks = Array.from({ length: 15 }, task);
    const results = await runWithDbConcurrency(tasks, 4);

    expect(results).toHaveLength(15);
    expect(peak).toBe(4);
  });

  it("defaults to the documented limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const tasks = Array.from({ length: DB_QUERY_CONCURRENCY * 3 }, () => async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return 1;
    });

    await runWithDbConcurrency(tasks);
    expect(peak).toBe(DB_QUERY_CONCURRENCY);
  });

  it("handles an empty list and a limit above the task count", async () => {
    expect(await runWithDbConcurrency([], 4)).toEqual([]);
    expect(await runWithDbConcurrency([deferred(1), deferred(2)], 99)).toEqual([1, 2]);
  });

  it("propagates the first rejection without hanging", async () => {
    const boom = () => Promise.reject(new Error("P2024: pool timeout"));
    await expect(runWithDbConcurrency([deferred(1), boom, deferred(3)], 2)).rejects.toThrow(
      /P2024/
    );
  });
});
