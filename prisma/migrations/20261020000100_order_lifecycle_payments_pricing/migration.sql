-- XeroxEase — authoritative order lifecycle, post-acceptance payments and
-- historical pricing snapshots.
--
-- ADDITIVE ONLY. No existing column is dropped, no row is rewritten and no enum
-- value is removed. Existing orders keep the legacy status they actually reached;
-- `OrderStatus` values are only APPENDED so every historical row remains valid.
--
-- Apply with `npx prisma migrate deploy` only after explicit operator approval.
-- The application code in this branch reads the new columns, so the migration must
-- be applied before (or together with) deploying it.

-- 1. New orders start as received. Existing rows are untouched.
-- The enum values were appended by the previous migration (20261020000000), so
-- this transaction may safely reference ORDER_RECEIVED.
ALTER TABLE "orders" ALTER COLUMN "status" SET DEFAULT 'ORDER_RECEIVED';

-- 2. Payment method (student's explicit choice, only after acceptance).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PaymentMethod') THEN
    CREATE TYPE "PaymentMethod" AS ENUM ('CASH_ON_DELIVERY', 'UPI');
  END IF;
END
$$;

ALTER TABLE "orders" ADD COLUMN "payment_method" "PaymentMethod";

-- 3. Lifecycle audit fields. Nullable, so old orders are unaffected.
ALTER TABLE "orders" ADD COLUMN "accepted_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "accepted_by" TEXT;
ALTER TABLE "orders" ADD COLUMN "rejected_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "rejected_by" TEXT;
ALTER TABLE "orders" ADD COLUMN "rejection_reason" TEXT;
ALTER TABLE "orders" ADD COLUMN "delivered_at" TIMESTAMP(3);

-- 4. Historical pricing snapshot. `total_amount`, `price_per_page` and
-- `finishing_fee` already exist and remain authoritative; the JSON records the
-- price table and finishing selection that produced them.
ALTER TABLE "orders" ADD COLUMN "pricing_snapshot" JSONB;
ALTER TABLE "orders" ADD COLUMN "finishing_options" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- 5. Payment-desk lookup filters method + status together.
CREATE INDEX "orders_payment_method_payment_status_idx"
  ON "orders"("payment_method", "payment_status");
