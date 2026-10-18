-- XeroxEase — document retention and abandoned-upload cleanup.
--
-- Adds `purged_at` to uploaded_files: the moment the stored object was deleted. A purged
-- row keeps its metadata (order history, page counts, billing evidence) but its document is
-- never served again and no longer counts against the uploader's quota.
--
-- This migration is ADDITIVE ONLY: one nullable column. No existing column, row, constraint
-- or index is modified or dropped. Existing rows are NULL (not purged), so applying it changes
-- no behaviour until the cleanup job runs. Code from before this change keeps working against
-- the resulting schema (old releases never read the column and would not clear it).
--
-- Before this, an abandoned or removed document lived forever: the student could not delete it,
-- and nothing enforced the retention period that the privacy notice describes.

ALTER TABLE "uploaded_files" ADD COLUMN "purged_at" TIMESTAMP(3);
