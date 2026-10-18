-- XeroxEase — one payment reference, one order.
--
-- A UPI / bank reference is evidence of one payment. Before this migration the same
-- reference could be submitted against any number of orders, and each order was then
-- verified separately. Submissions are now normalised (trimmed, upper-cased, whitespace
-- removed) and the database rejects a second order that presents the same reference.
--
-- This migration is ADDITIVE ONLY: one unique index on an existing nullable column.
-- It FAILS (and changes nothing) if two orders already share a payment_ref. That is
-- deliberate. Before running it against production, check for duplicates:
--
--   SELECT payment_ref, count(*) FROM orders
--    WHERE payment_ref IS NOT NULL GROUP BY payment_ref HAVING count(*) > 1;
--
-- The query must return zero rows. If it does not, decide which order owns each
-- reference, clear the others' payment_ref deliberately, then deploy.

CREATE UNIQUE INDEX "orders_payment_ref_key" ON "orders"("payment_ref");
