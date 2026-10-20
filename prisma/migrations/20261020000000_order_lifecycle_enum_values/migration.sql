-- XeroxEase — append new order lifecycle / notification enum values.
--
-- Kept in its OWN migration on purpose: PostgreSQL allows `ALTER TYPE ... ADD
-- VALUE` inside a transaction, but the new value cannot be *used* until that
-- transaction commits. The next migration sets `orders.status`'s default to
-- 'ORDER_RECEIVED', which would fail with "unsafe use of new value of enum type"
-- if both statements shared a migration.
--
-- ADDITIVE ONLY: values are appended, never renamed or removed, so every
-- historical order remains valid and no row is rewritten.
--
-- Apply with `npx prisma migrate deploy` only after explicit operator approval.

ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'ORDER_RECEIVED';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'ACCEPTED';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'READY_FOR_PICKUP';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'DELIVERED';
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'REJECTED';

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ORDER_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ORDER_ACCEPTED';
