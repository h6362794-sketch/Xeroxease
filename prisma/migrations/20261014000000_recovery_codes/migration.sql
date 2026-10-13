-- XeroxEase — email-free account recovery
--
-- Adds the `recovery_codes` table that replaces the removed email-link password
-- reset. This migration is ADDITIVE ONLY: it creates one new table and two foreign
-- keys. It does not modify, drop or rewrite any existing table or row.
--
-- The now-unused `password_reset_tokens` table is deliberately NOT dropped here,
-- because dropping a table is irreversible. See the deprecation note on
-- `User.passwordResets` in prisma/schema.prisma for the follow-up procedure.

CREATE TABLE "recovery_codes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "expires_at" TIMESTAMP(3),
    "used_at" TIMESTAMP(3),
    "rotated_at" TIMESTAMP(3),

    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("id")
);

-- One active recovery code per account: issuing a new one supersedes the old row,
-- which is what makes rotation safe (no window with two live codes).
CREATE UNIQUE INDEX "recovery_codes_user_id_key" ON "recovery_codes"("user_id");

-- Code hashes are unique so a hash lookup resolves to exactly one account.
CREATE UNIQUE INDEX "recovery_codes_code_hash_key" ON "recovery_codes"("code_hash");

ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
