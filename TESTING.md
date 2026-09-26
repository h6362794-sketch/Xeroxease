# XeroxEase — Testing Guide

## Run

```bash
npm test            # full unit suite (Vitest)
npm run test:watch  # watch mode
npm run typecheck   # strict TypeScript
npm run lint        # ESLint (Next.js core-web-vitals)
```

Current suite: **45 tests, 4 files** — all passing.

## Unit test coverage

| File | Covers |
|---|---|
| `tests/pricing.test.ts` | Price engine: single/double sides, copies, finishing fees, rounding, unknown keys, missing table |
| `tests/page-selection.test.ts` | Custom page ranges: lists, ranges, dedup, out-of-bounds, reversed, injection-style garbage, ALL |
| `tests/file-validation.test.ts` | Upload security: traversal stripping, control chars, double extensions (exe-renamed-to-pdf), MIME mismatch, **magic-byte spoofing rejection**, size limits, octet-stream handling |
| `tests/order-rules.test.ts` | Status machine: legal transitions, skipped stages, terminal states, unknown states, cancellable windows |

## Security test matrix

The suite directly asserts the security behaviors required by the spec:

- ✅ Manipulated **file type**: executable magic bytes renamed `.pdf` → rejected (`validateUpload`)
- ✅ **Oversized file**: >100 MB → rejected
- ✅ **Malicious filename**: `../../etc/passwd.pdf`, control chars, `invoice.pdf.exe` → sanitized/rejected
- ✅ **Invalid order status transition**: e.g. `ORDER_PLACED → PRINTING` → not allowed
- ✅ **Terminal states**: COMPLETED/CANCELLED/FAILED cannot transition
- ✅ **Price integrity**: server engine is the only calculator; client input absent from `calculatePrice`

### Manual security checks (require a running app + DB)

These are covered by server-side guards; verify with curl/Postman:

| Check | Expected |
|---|---|
| Student GETs another student's `/api/orders/:id` | 403 |
| Student GETs another student's `/api/files/:id/download` | 403 + `FILE_ACCESS_DENIED` audit |
| Student calls `/api/admin/*` | 403 |
| ADMIN calls Super Admin endpoints (pricing PATCH, users POST, settings) | 403 |
| Student POSTs a fabricated `totalAmount` with order | Ignored — server recalculates |
| Student PATCHes own payment to CONFIRMED | No such endpoint; verify-only via admin |
| Duplicate payment submission | Idempotent response, no duplicate events |
| Duplicate feedback | 409 |
| 9 rapid logins | 429 rate limit; account lockout at threshold |
| `.exe` renamed to `.pdf` uploaded | 400 (signature mismatch) |
| Unauthenticated `/dashboard` | Redirect to `/login` (server-side) |

## E2E acceptance walkthrough

Run the full flow from the spec's acceptance list:

1. Register a student → login
2. Upload a PDF → analysis shows page count
3. Configure (A4, B&W, double-side, 2 copies, staple) → review shows estimate
4. Place order → `XE-YYYY-NNNNNN` issued; server total in DB matches rate table
5. Submit payment reference → status UNDER_REVIEW
6. Admin → Payments → Verify → student notified, status PAYMENT_CONFIRMED
7. Admin → Orders → PRINTING → QUALITY_CHECK → READY_FOR_COLLECTION
8. Student → reveal collection code; admin verifies via `/api/admin/collection` → order COMPLETED, code single-use (replay rejected)
9. Student rates the order; duplicate rating blocked
10. Invoice printable from order page
