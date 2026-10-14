# XeroxEase — Efficient Document Solutions

A production-grade, full-stack document-printing platform for students: **upload → AI page detection → customize → QR payment → track → collect → rate.**

Built with Next.js 14, TypeScript (strict), Tailwind CSS, Framer Motion, Prisma, and Supabase PostgreSQL.

---

## ✨ Features

### Students
- **Register / login** with email or registration number; **email-free password recovery** via a single-use 160-bit recovery code you generate yourself (no mail provider, no paid service)
- **Multi-step order wizard**: drag-and-drop upload (PDF/DOC/DOCX/PPT/PPTX, 100 MB/file), AI page detection, print configuration (A4/Legal, colour required, sides, copies, custom page ranges), finishing (staple/spiral/stick file), review, QR payment, confirmation
- **Server-verified page counts** — pricing is always computed on the server from parsed documents
- **QR payment workflow**: scan the desk's UPI QR, submit the transaction reference, admin verifies
- **Live order tracking** with an animated status timeline and polling updates
- **Collection QR code** (single-use, HMAC-signed) when the order is ready
- **Order history** with search/filter/pagination, invoices, reorder hints, cancellation when eligible
- **Feedback & star ratings** after completion
- **In-app notifications** for every order/payment milestone

### Admins (no public admin signup — provisioned by Super Admin)
- **Dashboard** with 12 live metrics, status distribution, recent feedback
- **Order management**: search, filter (status/payment), sort, pagination, status transitions (server-validated), page-count correction (audited), secure file access
- **Payment verification**: review/verify/reject with notes
- **Feedback analytics**: average rating, distribution, moderation (Super Admin)
- **User management**: search, disable/enable (Super Admin), create admin accounts (Super Admin)
- **Pricing management**: database-driven rates (Super Admin)
- **System settings**: upload/replace/enable/disable payment QR, instructions, retention, queue capacity (Super Admin)
- **Audit logs**: immutable trail of privileged actions (Super Admin)

### Security (defense-in-depth)
- Argon2id password hashing (bcrypt fallback) · HTTP-only session cookies · server-side session validation
- Strict RBAC (STUDENT / ADMIN / SUPER_ADMIN) enforced at the API layer — never from the client
- IDOR protection: every order/file/invoice request verifies ownership or privileged authorization
- Upload hardening: extension + MIME + magic-byte signature checks, filename sanitization, double-extension rejection, size limits, private storage
- Zod validation on every endpoint · rate limiting per endpoint class · brute-force account lockout
- Security headers: CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy
- Full audit logging for privileged actions (no secrets logged)

See [`SECURITY.md`](SECURITY.md) for the threat model and remaining deployment risks.

---

## 🚀 Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env.local
# → Fill in your Supabase PostgreSQL connection string + SESSION_SECRET

# 3. Validate your configuration (optional but recommended)
npm run config:check

# 4. Set up the database (applies the committed migrations)
npx prisma migrate deploy

# 5. Seed development data (demo accounts, pricing, sample orders — dev only)
npm run db:seed

# 6. Run
npm run dev
```

Open http://localhost:3000 — the intro animation plays once (Skip button available, suppressed for returning visitors and reduced-motion users).

### Dev-only credentials (from seed)

| Role | Email | Password |
|---|---|---|
| Student | `student@college.edu` | `Student@123` |
| Student 2 | `student2@college.edu` | `Student@123` |
| Admin | `admin@xeroxease.local` | `Admin@123` |
| Super Admin | `superadmin@xeroxease.local` | `Admin@123` |

> ⚠️ These are documented development credentials. **Rotate all credentials in any non-dev environment.**

Full setup walkthrough: [`SETUP.md`](SETUP.md) · Database details: [`DATABASE.md`](DATABASE.md)

---

## 🧱 Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14 (App Router), React 18, TypeScript strict |
| Styling | Tailwind CSS, custom design tokens (Netflix-inspired dark theme) |
| Motion | Framer Motion (reduced-motion aware) |
| Database | Supabase PostgreSQL + Prisma ORM |
| Auth | Custom sessions (HTTP-only cookies), Argon2id |
| Storage | Private local directory (development) / Supabase Storage (production) |
| Validation | Zod on every external input |
| Tests | Vitest (100 unit tests) + GitHub Actions CI |

---

## 📁 Project Structure

```
src/
  app/                  # App Router pages + API routes
    (auth)/             #   login, register, forgot-password (recovery-code reset)
    (student)/          #   dashboard, orders, notifications, profile (server-guarded)
    admin/              #   /admin/login + (panel)/ dashboard pages (RBAC-guarded)
    api/                #   REST API (auth, uploads, documents, orders, payment, admin)
  components/           # Shared UI system + logo, nav, timeline, toasts
  features/             # Feature modules (landing, student, admin) — client components
  lib/                  # Constants, utils, api client, status metadata, prisma
  server/               # Server-only: auth, RBAC, validation, pricing, storage,
                        # doc-analysis, orders service, audit, notifications, settings
prisma/                 # schema.prisma + seed.ts
tests/                  # Vitest unit tests (pricing, page-selection, file-validation, order rules)
public/brand/           # Provided XeroxEase logo + intro animation
```

---

## 📜 Scripts

```bash
npm run dev          # Development server
npm run build        # prisma generate + next build (production)
npm start            # Production server
npm run typecheck    # tsc --noEmit
npm run lint         # next lint
npm test             # vitest run
npm run db:migrate   # prisma migrate dev (create a new migration)
npm run db:deploy    # prisma migrate deploy (production)
npm run db:status    # prisma migrate status
npm run config:check # validate environment configuration
npm run db:seed      # seed development data
```

---

## 📚 Documentation

- [`SETUP.md`](SETUP.md) — step-by-step setup with a fresh Supabase project
- [`DATABASE.md`](DATABASE.md) — schema, relationships, migrations, backups
- [`API.md`](API.md) — endpoint reference
- [`SECURITY.md`](SECURITY.md) — threat model, security architecture, deployment risks
- [`DEPLOYMENT.md`](DEPLOYMENT.md) — production deployment guide
- [`TESTING.md`](TESTING.md) — test suite and security test matrix
- [`SEED.md`](SEED.md) — seed data reference

---

## Notes

- The payment flow is **QR/scanner-based** with manual admin verification by design (no payment gateway, no card data). The system never auto-confirms payments without a verified integration.
- Uploaded documents live in **private storage** and are served only via authenticated, ownership-checked endpoints. Production requires `STORAGE_BACKEND=supabase` (or an explicit `ALLOW_EPHEMERAL_LOCAL_STORAGE=true`), because ephemeral disks silently lose documents that the database still references.
- Page counts are only priced when **verified**. Heuristic estimates (raw-byte PDF counting, page-break counting, legacy `.doc`) return an explicit `NEEDS_REVIEW` state that the student or an administrator must confirm before ordering.
- QR collection is **atomic**: concurrent scans of the same collection code produce exactly one fulfilled order.
- This project aims for strong defense-in-depth; **no system is "100% secure"** — see SECURITY.md for remaining operational responsibilities.
