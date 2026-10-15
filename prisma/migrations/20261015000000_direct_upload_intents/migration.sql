-- XeroxEase — direct-to-private-storage uploads
--
-- Adds the server-side state needed to authorize an upload that never passes through an
-- application function, and to verify it afterwards. This migration is ADDITIVE ONLY:
-- two nullable columns and one index. No existing column, row, constraint or index is
-- modified or dropped, so it is safe to apply to a live database and safe to run code
-- from before this change against the resulting schema (old releases simply never read
-- the new columns).
--
-- * `intent_expires_at` bounds the window in which a PENDING document may still be
--   completed. Past it, the row and any object left at its key are garbage that
--   `releaseExpiredIntents()` (SUPER_ADMIN maintenance route, no cron required) deletes.
-- * `intent_token_hash` stores only a SHA-256 digest of the completion token, so a row
--   dump cannot be replayed, and re-issuing an intent invalidates the previous token.
--   It is UNIQUE so one token can never authorize two different documents.
-- * `verified_at` records when the stored object was independently measured and
--   signature-checked — the moment a document becomes safe to attach to an order.

ALTER TABLE "uploaded_files" ADD COLUMN "intent_expires_at" TIMESTAMP(3);
ALTER TABLE "uploaded_files" ADD COLUMN "intent_token_hash" TEXT;
ALTER TABLE "uploaded_files" ADD COLUMN "verified_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "uploaded_files_intent_token_hash_key" ON "uploaded_files"("intent_token_hash");

CREATE INDEX "uploaded_files_status_intent_expires_at_idx"
    ON "uploaded_files"("status", "intent_expires_at");
