# XeroxEase — Seed Data Reference

Run: `npm run db:seed` (or `npx tsx prisma/seed.ts`)

## What it creates

**Pricing (idempotent upsert):**

| Key | Label | Price |
|---|---|---|
| `A4_BW` | A4 Black & White | ₹2 /page |
| `A4_COLOR` | A4 Colour | ₹8 /page |
| `LEGAL_BW` | Legal Black & White | ₹3 /page |
| `LEGAL_COLOR` | Legal Colour | ₹10 /page |
| `STAPLE` | Staple | ₹5 |
| `SPIRAL` | Spiral Binding | ₹40 |
| `STICK_FILE` | Stick File | ₹25 |

**Accounts** (Argon2id hashes; only a SHA-256 hash of reset tokens and Argon2id hashes of passwords are ever stored):

| Role | Email | Password |
|---|---|---|
| STUDENT | `student@college.edu` | `Student@123` |
| STUDENT | `student2@college.edu` | `Student@123` |
| ADMIN | `admin@xeroxease.local` | `Admin@123` |
| SUPER_ADMIN | `superadmin@xeroxease.local` | `Admin@123` |

**Demo orders** (only if the orders table is empty):
- `XE-2026-000001` — student 1, READY_FOR_COLLECTION (payment confirmed)
- `XE-2026-000002` — student 2, COMPLETED with 5★ feedback

**Settings**: default payment instructions, cancellation rules (`ORDER_PLACED`, `PAYMENT_PENDING`, `PAYMENT_UNDER_REVIEW`), 30-day retention, 900 pages/hour queue capacity. Payment QR is **not** set — upload one via Admin → Settings.

## Re-running

The seed is idempotent: pricing and users upsert, demo orders are created only when absent.

## ⚠️ Credentials policy

These passwords are **published in the repository for development convenience only**.

- Never reuse them in staging/production.
- `npm run db:seed` **refuses to run** in production (`NODE_ENV=production`) unless
  every account password comes from the environment:
  - `SEED_ADMIN_PASSWORD` is **mandatory in production** — there is no fallback,
    generated or default. A privileged account must never be created with a
    publicly documented password, nor with a random password nobody can learn
    (that would lock the operator out of a fresh deployment, because recovery
    codes are self-generated in the profile). The recommended production path is
    to create the first admin through the Super Admin console instead of seeding.
  - `SEED_STUDENT_PASSWORD` is likewise required in production unless
    `ALLOW_DEV_SEED=true` is set explicitly.
  - Supplied passwords must be ≥ 12 characters with upper, lower and a digit —
    the published defaults (`Student@123`, `Admin@123`) are rejected when
    supplied explicitly, even in development.
- Supply your own values instead:
  ```bash
  SEED_STUDENT_PASSWORD="<strong unique value, 12+ chars>" \
  SEED_ADMIN_PASSWORD="<strong unique value, 12+ chars>" \
  npm run db:seed
  ```
- The seed prints **account identifiers and password provenance only**.
  Passwords and hashes are never written to logs or stdout.
- **Reseeding never changes credentials**: user upserts carry an empty
  `update` clause, so an existing account keeps its current password hash,
  active state and all other fields. The seed also never deletes or
  disables accounts. Rotate credentials through the Super Admin console
  (Admin → Users) or the recovery-code flow (Profile → Security).
- Demo orders are skipped entirely in production.
- Production must always use unique, strong credentials — see DEPLOYMENT.md checklist.
