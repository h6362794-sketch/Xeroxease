// Static migration/source contract only. This does not replay SQL, prove
// deployment schema compatibility, or authorize running against any database.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const enumName = "20261020000000_order_lifecycle_enum_values";
const columnsName = "20261020000100_order_lifecycle_payments_pricing";
const enums = readFileSync(`prisma/migrations/${enumName}/migration.sql`, "utf8");
const columns = readFileSync(`prisma/migrations/${columnsName}/migration.sql`, "utf8");
const code = (text: string) => text.replace(/--[^\n]*/g, "");
it("adds every required enum value before the separate migration uses its default", () => {
  expect(enumName < columnsName).toBe(true);
  expect([...enums.matchAll(/ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS '([^']+)'/g)].map(x => x[1])).toEqual([
    "ORDER_RECEIVED", "ACCEPTED", "READY_FOR_PICKUP", "DELIVERED", "REJECTED",
  ]);
  expect([...enums.matchAll(/ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS '([^']+)'/g)].map(x => x[1])).toEqual([
    "ORDER_REJECTED", "ORDER_ACCEPTED",
  ]);
  expect(code(enums)).not.toContain("SET DEFAULT");
  expect(columns).toContain('ALTER COLUMN "status" SET DEFAULT \'ORDER_RECEIVED\'');
});
it("adds the nine intended columns, payment enum and index without destructive data SQL", () => {
  expect([...columns.matchAll(/ADD COLUMN "([^"]+)"/g)].map(x => x[1])).toEqual([
    "payment_method", "accepted_at", "accepted_by", "rejected_at", "rejected_by", "rejection_reason", "delivered_at", "pricing_snapshot", "finishing_options",
  ]);
  expect(columns).toContain('CREATE TYPE "PaymentMethod" AS ENUM (\'CASH_ON_DELIVERY\', \'UPI\')');
  expect(columns).toContain('"finishing_options" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]');
  expect(columns).toContain('ON "orders"("payment_method", "payment_status")');
  expect(code(enums + columns)).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|RENAME)\b/i);
});
