# Payment reference collision plan (blocked: owner approval required)

Status: **blocked**. No normalisation of stored payment references and no migration of the
`orders.payment_ref` unique index may run until the owner approves the decision in section 4.
Nothing in this repository changes existing payment evidence.

## 1. What the code does today

| Path | Behaviour |
| --- | --- |
| New submission (`paymentSubmitSchema`) | Trims, removes all whitespace, upper-cases, then checks the alphabet `[A-Z0-9][A-Z0-9_\-/.]{3,63}`. The normalised value is stored. |
| Duplicate check (`payment/submit`) | `order.findFirst({ paymentRef: <normalised>, NOT: { id } })` inside the transaction. This compares normalised input with **stored** values. |
| Database (migration `20261018000000_payment_reference_unique`) | `CREATE UNIQUE INDEX orders_payment_ref_key ON orders(payment_ref)`. Compares **raw** strings. |
| Conflict mapping | P2002 on `payment_ref` returns the duplicate message. |

## 2. Gaps (verified by reading the code; the database has not been queried for them)

1. **Legacy rows are not normalised.** Submissions made before normalisation may be stored as
   typed, for example `utr 1234`. A new submission `UTR1234` normalises to a different string,
   so neither the duplicate check nor the unique index sees the collision.
2. **Migration passes on case/whitespace duplicates.** The index succeeds if legacy rows differ
   only by case or whitespace. The migration file says so and asks for the normalised query
   before running it.
3. **Check-then-write before the index exists.** Until the migration is recorded in the target
   database, the duplicate check is a read followed by a write. Two concurrent submissions for
   different orders with the same reference can both pass. This is a real race and is removed
   only by the unique index.
4. **Separators are significant.** `UTR-1234` and `UTR1234` are different references. This is
   deliberate for now, because a bank could issue both forms.

Read-only counts from an earlier round (raw equality, not normalised): 0 duplicate
`payment_ref` values in the Supabase project. The normalised query in the migration file has
**not** been run against any database in this round.

## 3. Options (decision needed)

- **A. Keep as is; run the normalised query first.** Deploy the migration only when it returns zero rows.
  Lowest risk. Legacy variants stay unindexed.
- **B. Resolve collisions, then migrate.** For any normalised group with more than one order, an
  owner decides which order keeps the reference. Other orders' `payment_ref` is cleared
  deliberately, after a backup, with an audit row per change. Then the migration runs.
- **C. Normalise stored legacy values.** Rewrite `payment_ref` to its normalised form. Only after B,
  because a rewrite can merge two orders' references.

Recommended: A, then B only if the normalised query finds groups. Do not choose C without B.

## 4. Owner decisions needed

1. Which option (A, B, or C) applies, and who approves the cleared-reference list under B.
2. Whether separators (`-`, `/`, `.`) are significant for the bank references you accept.
3. The backup location and retention for the pre-change `orders` rows under B.

## 5. Steps once approved (not run)

1. Back up `orders` (payment columns) in the target database.
2. Run the normalised query from the migration file. Zero rows: deploy the migration. Otherwise
   follow the owner-approved resolution for each group, then deploy.
3. Verify with `SELECT count(*) FROM orders WHERE payment_ref IS NOT NULL` before and after.
4. Record the migration in the target database only after step 2 succeeds.

No step in this plan has been run.
