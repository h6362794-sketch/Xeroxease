# XeroxEase — Responsive, Accessibility & Staging Checklist

Automated tests pin the code paths (lifecycle, payments, documents, pricing, helpline
configuration, intro-video CSS). They **cannot** prove pixels, focus order or touch
targets. Run this checklist on a staging deployment before promoting the 2026-10
lifecycle/payments/pricing change.

Record the human who signed it off, the build/commit and the date. Treat any unchecked
box as an open item, not a pass.

---

## 1. Devices & viewports

Test each in **portrait and landscape**. Use real devices where possible; at minimum
Chrome DevTools device emulation plus one physical phone.

| Class | Viewports |
|---|---|
| Small phone | 320×568, 360×640, 375×667 |
| Large phone | 390×844, 412×915 |
| Tablet | 768×1024, 820×1180 |
| Laptop | 1024×768, 1280×800 |
| Desktop | 1440×900, 1920×1080 |

For every screen below check: **no horizontal page scroll** (except a deliberately
scrollable table container, which must scroll inside its own card), no clipped text, no
overlapping controls, and stable layout while loading (no jump when data arrives).

### Screens

- [ ] Landing page — hero, feature grid, **pricing section** (live price fetch: loading
      skeletons, empty state, error + retry)
- [ ] Intro overlay — plays fully within the viewport, not cropped, Skip reachable
- [ ] Login / Register — helpline block visible near the top, no shift when it is absent
- [ ] Student dashboard — helpline card above the fold, stat cards wrap, order list
- [ ] Order wizard (6 steps) — upload drop zone, file rows, configure grids, review table
- [ ] Student order detail — 5-step timeline, payment panel, UPI QR, reference input,
      collection code, invoice button, cancel/rate actions
- [ ] Student orders list — status filter, cards at 320 px
- [ ] Admin dashboard — stat cards, status chart, feedback list
- [ ] Admin orders table — desktop table scrolls inside its card; mobile card list
- [ ] Admin order lookup — filters stack, results table/cards, pagination controls
- [ ] Admin order detail — header, files (preview/download), pricing breakdown, status
      form, payment verification panel, status/payment history
- [ ] Admin payments — state tabs scroll or wrap, verify/reject dialogs
- [ ] Admin pricing — editable rows, history list, save feedback
- [ ] Dialogs (confirm delivery, reject, cancel, verify payment) — fit at 320×568 and in
      landscape, body scroll locked, close/Skip reachable

---

## 2. Accessibility

### Keyboard only (no mouse)

- [ ] Tab order follows visual order on every screen above; the intro overlay traps
      nothing and Escape closes it.
- [ ] Visible focus ring on every interactive element (links, buttons, tabs, method
      cards, file actions, dialog fields).
- [ ] Admin navigation marks the current page (`aria-current="page"`) and
      `/admin/orders/lookup` does not also highlight `/admin/orders`.
- [ ] Payment method cards are operable by keyboard and expose their selected state
      (`aria-pressed`).
- [ ] Dialogs: focus moves in, stays inside while open, returns to the trigger on close;
      Escape cancels.
- [ ] No keyboard trap anywhere; no control reachable only by hover.

### Semantics, labels, announcements

- [ ] Every input has a programmatic label (`Label htmlFor` / `aria-label`); required
      fields are marked in text, not colour alone.
- [ ] The timeline is a list with the current step announced as `aria-current="step"`;
      screen reader reads stage labels, not enum names.
- [ ] Loading regions expose `aria-busy`; errors are announced (live region or focus) and
      are not colour-only.
- [ ] Status badges include readable text (e.g. "Not Accepted"), not just a dot.
- [ ] Payment/order errors from the API are rendered as text next to the control and are
      product-safe (no stack traces, ids, keys).
- [ ] `tel:` link has an accessible name that includes the number; no number shown when
      unconfigured.

### Contrast & touch targets (WCAG AA)

- [ ] Body text ≥ 4.5:1, large text ≥ 3:1, focus indicators ≥ 3:1 against their surround.
- [ ] Every interactive target ≥ 44×44 px effective (helpline link, file preview/download,
      payment method cards, tabs, pagination, dialog buttons).
- [ ] Disabled controls are visually distinct **and** still meet text contrast, and are not
      the only way a failure is communicated.

### Motion

- [ ] With `prefers-reduced-motion: reduce`: the intro is skipped, reveal animations are
      disabled, and nothing auto-plays.
- [ ] No animation blocks input; polling updates do not steal focus.

---

## 3. Intro video (feature-specific)

- [ ] `public/brand/xeroxease-intro.mp4` plays muted, inline, automatically where the
      browser allows.
- [ ] Whole composition visible on every viewport above — `object-contain`, letterboxed
      rather than cropped.
- [ ] Skip button visible and ≥ 44 px; tapping anywhere and pressing Escape also closes.
- [ ] Second visit in the same session skips the intro (`sessionStorage`), and storage
      being blocked does not break the page.
- [ ] Poster shows while loading; a blocked/failed video shows the fallback panel with
      "Enter site".
- [ ] No layout shift or scrollbar flash when the overlay closes.
- [ ] Performance: the overlay does not block first contentful paint beyond the intro, and
      the video is not preloaded on every navigation.

---

## 4. Helpline (feature-specific)

- [ ] With `NEXT_PUBLIC_SUPPORT_PHONE` **unset**: login, register and dashboard render the
      fallback text; no `tel:` link exists.
- [ ] With a valid number: link is clickable on a real phone and dials the configured
      number, not a placeholder.
- [ ] Invalid value (letters, too short, `++`) behaves like unset.
- [ ] Link is not obfuscated by an `onclick` handler and contains no personal data.
- [ ] Changing the number requires a rebuild (it is build-time inlined) — note this in the
      release steps.

---

## 5. Lifecycle & payment behaviour (staging, real database)

- [ ] New order appears as **Order Received** in student and admin views and in analytics.
- [ ] Cancel is offered before acceptance and works; the status becomes **Cancelled** and
      history is retained.
- [ ] After **Accept**, cancel is hidden with an explanation, and
      `POST /api/orders/:id/cancel` returns `409`.
- [ ] Accept → Printing → Ready for Pickup → **Delivered** (confirmation dialog) updates
      both portals; the delivered order offers no further transitions.
- [ ] Repeating a transition in a second tab returns a clear conflict message and does not
      double-notify.
- [ ] Reject requires a reason (≥ 3 chars) and `confirm`; student sees **Not Accepted** and
      the reason; the order is not presented as a progress step.
- [ ] Cash: selecting cash leaves payment pending; "mark cash received" records actor/time
      and does not move the print status.
- [ ] UPI: QR and merchant details show the server-calculated amount; submitting a
      reference moves to **Reference submitted**; it is **not** paid; a second submit is
      refused; verify records the decision; reject requires a reason and allows resubmit.
- [ ] Historical order (created before this change) still opens, shows its legacy status,
      and can be progressed to completion.
- [ ] Admin order detail previews and downloads **every** attached PDF; a file id from a
      different order returns 404; filenames display correctly (including non-ASCII).

## 6. Pricing behaviour (staging)

- [ ] Landing pricing and the order wizard show the **same** active prices.
- [ ] A SUPER_ADMIN price change is reflected for a **new** order and appears in the audit
      history with previous → new.
- [ ] An existing order's total and `pricing_snapshot` do not change after a price edit; its
      invoice still shows the original amount.
- [ ] An ADMIN (not SUPER_ADMIN) is blocked in the UI **and** by the API (`403`).
- [ ] Invalid values (negative, > 10000, 3 decimals) are rejected with a readable message.
- [ ] Two admins editing the same key: the second gets a conflict, no silent overwrite.

---

## 7. Release / rollback

- [ ] Migration order respected: `20261020000000_order_lifecycle_enum_values` **then**
      `20261020000100_order_lifecycle_payments_pricing`.
- [ ] `prisma migrate status` reports up to date; CI `migrations` job is green.
- [ ] `NEXT_PUBLIC_SUPPORT_PHONE` set (or deliberately empty) in the build environment and
      documented; no secret in the bundle.
- [ ] Storage bucket remains **private**; no public URL exists for any document.
- [ ] Rollback plan: code rollback is safe (new columns are additive and nullable), but
      legacy code will not understand `DELIVERED`/`REJECTED`/`ACCEPTED` rows — decide the
      forward-fix path before deploying during active printing hours.

---

## Sign-off

| Field | Value |
|---|---|
| Commit / build | |
| Environment | staging |
| Tester | |
| Date | |
| Open items | |
