// Regression coverage for schema-version skew classification.
//
// The 2026-10-20 /dashboard incident produced only a numeric digest in the browser
// and, server-side, a Prisma code. The missing *object* — which column or enum label —
// is what identifies the unapplied migration, and it was not recoverable from either.
// `describeSchemaSkew` recovers exactly that, and must do so without ever letting
// message text, SQL parameters or credentials into a production log.
import { describe, expect, it } from "vitest";
import { describeSchemaSkew, isSchemaSkewError } from "@/server/schema-skew";

/** The real Prisma P2022 message shape for the incident. */
const P2022_MESSAGE =
  "The column `orders.pricing_snapshot` does not exist in the current database.";

/** The real PostgreSQL SQLSTATE shape Prisma wraps for a raw query. */
const RAW_42703 =
  'Raw query failed. Code: `42703`. Message: `column "orders.pricing_snapshot" does not exist`';

describe("schema skew classification", () => {
  it("classifies the P2022 column failure from the incident and names the column", () => {
    const error = Object.assign(new Error(P2022_MESSAGE), { code: "P2022" });
    expect(describeSchemaSkew(error)).toEqual({
      kind: "missing-column",
      prismaCode: "P2022",
      pgCode: "42703",
      object: "orders.pricing_snapshot",
    });
  });

  it("recovers the column and SQLSTATE from a raw-driver 42703 error", () => {
    expect(describeSchemaSkew(new Error(RAW_42703))).toMatchObject({
      kind: "missing-column",
      pgCode: "42703",
      object: "orders.pricing_snapshot",
    });
  });

  it("classifies the 22P02 enum failure and names the missing label", () => {
    // This is the *second* failure the same deploy produces: the dashboard filter
    // binds DELIVERED, which the production enum did not contain.
    const error = new Error('invalid input value for enum "OrderStatus": "DELIVERED"');
    expect(describeSchemaSkew(error)).toMatchObject({
      kind: "missing-enum-value",
      pgCode: "22P02",
      object: "OrderStatus.DELIVERED",
    });
  });

  it("classifies a missing relation and a missing enum type", () => {
    expect(describeSchemaSkew(new Error('relation "orders" does not exist'))).toMatchObject({
      kind: "missing-table",
      pgCode: "42P01",
      object: "orders",
    });
    expect(describeSchemaSkew(new Error('type "PaymentMethod" does not exist'))).toMatchObject({
      kind: "missing-enum-type",
      pgCode: "3F000",
      object: "PaymentMethod",
    });
  });

  it("still classifies a bare P2022 with no usable message", () => {
    expect(describeSchemaSkew(Object.assign(new Error("failed"), { code: "P2022" }))).toEqual({
      kind: "missing-column",
      prismaCode: "P2022",
    });
  });

  it("does not guess: P2023 without enum evidence is not schema skew", () => {
    // P2023 also covers ordinary conversion failures. Treating those as schema drift
    // would create false alarms and send operators chasing migrations.
    expect(describeSchemaSkew(Object.assign(new Error("Inconsistent column data"), { code: "P2023" }))).toBeUndefined();
  });

  it("ignores unrelated database errors", () => {
    expect(describeSchemaSkew(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }))).toBeUndefined();
    expect(describeSchemaSkew(new Error("Timed out fetching a new connection from the connection pool"))).toBeUndefined();
    expect(isSchemaSkewError(new Error("REDIRECT:/login"))).toBe(false);
  });

  it("is total: non-errors and hostile inputs never throw", () => {
    for (const value of [null, undefined, 0, 1, "", "boom", true, Symbol("x"), [], {}]) {
      expect(() => describeSchemaSkew(value)).not.toThrow();
      expect(describeSchemaSkew(value)).toBeUndefined();
    }
    // A message getter that throws must not escape.
    const hostile = {
      code: "P2022",
      get message(): string {
        throw new Error("boom");
      },
    };
    expect(() => describeSchemaSkew(hostile)).not.toThrow();
  });
});

describe("schema skew output sanitisation", () => {
  it("never emits multi-line content or forged stack frames", () => {
    const forged = 'column "x\n    at /var/task/app.js:1:1" does not exist';
    const result = describeSchemaSkew(new Error(forged));
    // Non-matching shapes are dropped rather than guessed at.
    expect(result).toBeUndefined();
  });

  it("keeps a valid identifier on a single line even when the message is multi-line", () => {
    const message = `The column \`orders.pricing_snapshot\` does not exist in the current database.\n    at /var/task/.next/server/chunks/1.js:10:5`;
    const result = describeSchemaSkew(Object.assign(new Error(message), { code: "P2022" }));
    expect(result?.object).toBe("orders.pricing_snapshot");
    expect(result?.object).not.toContain("\n");
    expect(JSON.stringify(result)).not.toContain("/var/task");
  });

  it("rejects captures that are not plain SQL identifiers", () => {
    // A message that embeds an email address or a URL must not become the object.
    const secrets = [
      'column "student@example.test" does not exist',
      'relation "https://user:pw@db.example.test/x" does not exist',
      'column "a/b/c" does not exist',
    ];
    for (const message of secrets) {
      const result = describeSchemaSkew(new Error(message));
      expect(result?.object).toBeUndefined();
    }
  });

  it("bounds the identifier length", () => {
    const huge = "a".repeat(500);
    const result = describeSchemaSkew(new Error(`column "${huge}" does not exist`));
    expect(result?.object).toBeUndefined();
  });

  it("emits only allowlisted keys — no message, stack, SQL or credentials", () => {
    const error = new Error(
      "The column `orders.pricing_snapshot` does not exist. params: password=hunter2 ssn=123-45-6789"
    );
    const serialised = JSON.stringify(describeSchemaSkew(error));
    expect(serialised).not.toContain("hunter2");
    expect(serialised).not.toContain("6789");
    expect(serialised).not.toContain("params");
    const keys = Object.keys(describeSchemaSkew(error) ?? {});
    expect(keys.length).toBeGreaterThan(0);
    // Every emitted key must be on the allowlist; nothing may be added to the shape.
    const ALLOWED = ["kind", "object", "pgCode", "prismaCode"];
    expect(keys.filter((key) => !ALLOWED.includes(key))).toEqual([]);
  });
});
