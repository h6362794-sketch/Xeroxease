# Launch policy review: payment references, privacy, retention, cancellation and pricing

Scope: a read-only review of the code, migrations and copy on branch `arena/89406898-xeroxease`.
Nothing here changes behaviour. Where a policy is not decided, the code is left safely blocked and the
decision needed is recorded. Items marked **verified in code** were checked by reading the code and
running tests. Items marked **not verified** need a live system or an owner's decision.

## 1. Payment-reference migration (`20261018000000_payment_reference_unique`)

| Point | Status |
| --- | --- |
| Migration is additive: one unique index on the nullable `orders.payment_ref`. It changes no data. | Verified in code. |
| It fails, and changes nothing, when two orders share a raw reference. | Verified in code (the SQL has no data step). |
| It does not catch legacy rows that differ only by case or whitespace. | Verified in code (the migration comment and `docs/payment-reference-collision-plan.md`, section 2). |
| The application normalises new submissions (trim, remove whitespace, upper-case) before the duplicate check. | Verified in code (`payment/submit` route and `paymentSubmitSchema`). |
| Schema and migration agree: `schema.prisma` has `paymentRef String? @unique`, and the migration creates the same index. | Verified by the CI drift check on `c54601c` (migration job succeeded). |
| Staging: the normalised collision query returns 0 groups (2 non-null references). | Verified read-only in round 5. Re-run before any decision. |
| Production: unknown. Not checked. | **Not verified.** |
| Staging migration recorded: **no** (`20261018…` not recorded on staging as of the last read). | Verified read-only earlier; re-check before any action. |

**Decision needed (owner):** collision option A, B or C (`docs/payment-reference-collision-plan.md`,
section 3). The recommendation is A, then B only if the normalised query finds groups. No normalisation
or migration may run before the owner decides. Also: whether `-`, `/` and `.` are significant in bank
references.

## 2. Privacy wording (`src/app/privacy/page.tsx`)

- Verified in code: the page says automatic removal of expired uploads and automatic deletion of order
  documents are **not yet switched on**. That matches the code: nothing runs the sweep on a timer
  (`DEPLOYMENT.md`, scheduled upload cleanup).
- Verified in code: the page says order records, payment references, page counts and file names are
  kept for accounting after the document is deleted.
- **Decision needed:** the retention period for those accounting records, including payment references.
  None is defined anywhere in the code or the docs. Until one is set, the privacy page is the only
  statement, and it says "for accounting" without a period.
- **Decision needed:** whether the privacy text should name the storage location and provider. Not
  verified, because the production provider configuration has not been checked.

## 3. Retention policy

| Class | Rule in code | Automatic? |
| --- | --- | --- |
| Unordered upload | Purged 24 hours after upload (`UNATTACHED_UPLOAD_TTL_HOURS`, fixed). | No. Needs the scheduler. |
| Order document | Purged `retentionDays` after the order completes, is cancelled or fails. Default 30, range 1–3650 (Settings). | No. Needs the scheduler. |
| Expired upload intent | Released by the sweep. | No. Needs the scheduler. |
| Purge mechanics | Claims the row first, deletes the object, sets `purged_at`. A failed object delete keeps the row. | Verified in code and by the PostgreSQL race tests (local run and CI). |

**Decisions needed (owner):**
1. Scheduler execution is deferred. It stays off (`SWEEP_ENABLED` unset) until the retention review and a
   written authorisation. This is the standing owner decision.
2. The retention default for order documents (30 days) is a business choice. Confirm it.
3. Whether payment references and page counts are kept for accounting beyond the document, and for how
   long. Currently undecided.

## 4. Paid-order cancellation and refunds

- Verified in code: `CANCELLABLE_STATUSES` (`src/lib/constants.ts`) includes `PAYMENT_CONFIRMED`,
  `DOCUMENTS_RECEIVED` and `PROCESSING`. A student can cancel an order that has been paid, received or
  started, and the cancel write is conditional on the status that was checked.
- Verified in code: the schema has **no refund field, table or event**. No server code records a refund.
  The cancel dialog says "If you've already paid, the desk will handle the refund manually." The
  cancellation reason is free text.
- Verified in code: an admin setting `PAYMENT_CONFIRMED` must enter a note (`94fd37e`), but no refund
  record is created when a paid order is cancelled.
- Consequence: a paid order can be cancelled with no record in the app that money is owed back. The
  only trace is an audit row and the order's cancel reason.

**Decisions needed (owner):**
1. Should students be allowed to cancel after payment is confirmed, or after printing starts? The
   safer default is to refuse, and to route those cases to the desk. This is not changed in this round.
2. Should refunds be recorded in the application (a refund record with amount, reference and actor), or
   handled outside it with a documented manual step?
3. What is the refund policy wording shown to students?

## 5. Pricing risks

| Risk | Status |
| --- | --- |
| An admin page-count correction on a document attached to an order changes the bill or the printed page count without repricing. | **Closed in this round** (`158c031`): every such correction is refused with 409 `ORDER_PRICED`. Verified by 23 tests and a PostgreSQL race test. |
| A student correcting a page count after it was placed. | Verified in code: the student route refuses once the document is attached (`orderId` set), and its write is conditional on `orderId null`. Verified by a PostgreSQL race test (`c54601c`). |
| Order price is stored at placement (`pricePerPage`, `finishingFee`, `totalAmount`, `totalPages`, `billablePages`), so later pricing-config edits do not reprice existing orders. | Verified in code (fields written by `createOrder`). |
| No repricing policy exists for placed orders. | **Decision needed (owner):** whether any repricing is ever allowed, who approves it, and the audit requirement. Until then, refusal is the default. |
| A document can be linked to an order only in `createOrder`, in one transaction, with the priced count and state in the predicate. | Verified in code and by a static invariant test (`cbba79c`). |
| Mocked tests cannot prove PostgreSQL serialisation. | The database-backed race tests were run locally against PostgreSQL 16 and in CI (see the report). |

## 6. Summary of what is still open

1. Payment-reference collision option (section 1).
2. Retention period for accounting records, and the scheduler decision (section 2 and 3).
3. Refund and cancellation policy for paid orders (section 4).
4. Repricing policy for placed orders (section 5). Refusal is the default.
5. `braces` dependency audit: blocks launch until an upstream fix or an owner-signed risk acceptance.
6. Vercel Production Branch setting: not verified (see the report).
