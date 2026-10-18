# XeroxEase — Uploads, Storage and Downloads

How document bytes move, what is verified, and what a deployment must provide. This file
is the reference for the direct-to-private-storage protocol; `DEPLOYMENT.md` covers the
platform checklist, `SECURITY.md` §4 the threat model.

---

## 1. Why the bytes bypass the application

Vercel Functions cap the **request *and* response** body at 4.5 MB (infrastructure-level;
`vercel.json` cannot raise it). XeroxEase accepts **50 MiB** documents
(`MAX_FILE_SIZE`, `src/lib/constants.ts`). Those two facts cannot coexist inside a
function, so on Vercel:

* **upload** goes browser → Supabase Storage, using a signed URL the app mints;
* **download** is a `307` to a short-lived signed URL, so bytes never stream through a
  function body;
* the app only ever handles **metadata** plus a 16-byte signature probe.

The legacy proxy path (`POST /api/uploads`, whole file through the app) still exists for
`STORAGE_BACKEND=local` in development and for the small admin payment-QR image.

---

## 2. The direct upload protocol

```
 browser                     Next.js API (Vercel)                Supabase Storage (private bucket)
 ────────                    ─────────────────────               ─────────────────────────────────
 1. POST /api/uploads
      /intent
    {filename,mimeType,
     sizeBytes}  →  session + quota +
                            extension/MIME/size validation
                            · creates uploaded_files row (status=PENDING)
                            · mints server-only storage key
                            · HMAC intent token (row+owner+key+size+exp)
                            · POST /object/upload/sign/{bucket}/{key}  ──→  signed PUT URL
    ← 201 {fileId, token, uploadUrl, maxBytes, expiresAt}

 2. PUT <uploadUrl>  ────────────────────────────────────────────────────────────────────→  bytes stored
    (raw body, no auth header: the URL carries
     the one-purpose token; 409 if an object exists)

 3. POST /api/uploads
      /complete
    {fileId, token}      →  verify HMAC + hash(token)==row.intent_token_hash
                            · GET /object/info/{bucket}/{key}      ──→  actual size
                            · GET first 16 bytes                    ──→  magic signature
                            · row.status = COMPLETED (in a transaction)
    ← 200 {file:{sizeBytes(verified), mimeType, ...}}

 4. (optional) POST /api/uploads/abort {fileId}   deletes the object + releases the row
```

Then the existing flow continues unchanged: `POST /api/documents/analyze` → confirm page
count if `NEEDS_REVIEW` → `POST /api/orders`. **Order creation only accepts documents
whose `status = COMPLETED`**, i.e. verified against storage (`src/server/orders.ts`).

### 2.1 Every authorization decision

| Step | Enforced by |
|---|---|
| Who may ask | session cookie; `requireUser()` — no session, no intent (401) |
| Which order | None. Intents carry no order: the body is strict, so an `orderId` field is refused with 422. A document joins an order only through `createOrder`, which checks state and page count and prices it. |
| Whose file | storage key and owner are **server-generated** (`buildStorageKey(sessionUser.id, …)`); the client never supplies a key or a user id |
| Quota | at most `MAX_FILES_PER_ORDER` unattached, un-expired documents per user |
| Size / type at request time | `decideUploadIntent()` — extension allow-list, double-extension rejection, declared-MIME↔extension agreement, `sizeBytes ≤ 50 MiB` (inclusive), and ≤ the provider cap if lower |
| Size / type after upload | `decideCompletion()` — measured size from storage, signature read back from stored bytes; **client metadata is never consulted** |
| Replay / forgery | HMAC-SHA256 token keyed on `SESSION_SECRET`, bound to `(fileId, uploaderId, storageKey, sizeBytes, exp, nonce)`; the row keeps only `SHA-256(token)` and it is `UNIQUE`, so one token can never authorize two documents |
| Expiry | both `claim.exp` and `uploaded_files.intent_expires_at` must still be in the future |
| Cross-user read | `authorizeDownload()` — owner or `ADMIN`/`SUPER_ADMIN`; a foreign id and a missing id return the identical 404 |
| Rate limiting | `uploadIntent` / `uploadComplete` 40 per 10 min **per user**, `download` 120 per 10 min per user; shared Redis store required for multi-instance hosts |

### 2.2 Failure behaviour (deliberate, and unit-tested)

| Condition | Result |
|---|---|
| Missing/short token, bad signature, foreign `fileId`, wrong key | 400/403 `TOKEN_*` / `KEY_MISMATCH`; row untouched |
| Replayed token after re-issuing an intent | 403 — the row's stored hash no longer matches |
| Intent expired | 410, object deleted, row `FAILED` |
| Object missing at the expected key | 409 `OBJECT_MISSING`; retry by re-uploading |
| Stored size > 50 MiB | 413, object deleted, row `FAILED` |
| Stored size ≠ declared size | 422 `SIZE_MISMATCH`, object deleted (a truncated/gzip'd PUT), row `FAILED` |
| Magic bytes don't match the extension | 422 `SIGNATURE_MISMATCH`, object deleted, row `FAILED` |
| Storage outage during verification | 503 `STORAGE_UNAVAILABLE`; row stays **PENDING** with a live intent → a retry re-verifies the *same* object, no re-upload |
| Database failure during completion | 503 `PERSIST_FAILED`; row stays PENDING, object kept, retry is idempotent |
| Repeated `complete` after success | 200 with the same verified payload; nothing re-read or rewritten |
| Abandoned PENDING row | released by `POST /api/admin/uploads/sweep` (SUPER_ADMIN or the `CRON_SECRET` bearer, capped, re-runnable). **There is no cron in this app** — see §5 |

---

## 3. Downloads

`GET /api/files/:id/download[?mode=view]`

1. Session required; per-user rate limit applies.
2. Row loaded by id; authorization = owner **or** admin role (desk staff must be able to
   print student uploads). Non-owner and non-existent give the *same* 404.
3. `status !== COMPLETED` → 404. An unverified object is not downloadable, by anyone.
4. `STORAGE_BACKEND=supabase` → `POST /object/sign/{bucket}/{key}` with
   `expiresIn = SIGNED_DOWNLOAD_URL_TTL_SECONDS` (default 60 s) and `download: <name>`
   unless `?mode=view`; respond **307** with
   `Cache-Control: private, no-store, max-age=0, must-revalidate`,
   `Pragma: no-cache`, `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`.
   No `Vary` is emitted: a cached redirect would cache the credential itself.
5. `STORAGE_BACKEND=local` → streamed response (never buffered), same cache discipline.
6. Signing failure → 503 `DOWNLOAD_UNAVAILABLE`. It never falls back to proxying a
   50 MB body, and provider error text is never forwarded.

`mode=view` (used by the admin "View file" link) requests inline display; the default is
attachment. Supabase can only force `attachment` on a signed URL, so "view" means "let
the browser decide", which for PDFs is inline.

The student link carries `rel="noopener noreferrer"` because the response's `Location`
embeds a bearer token — no referrer must be able to carry it onward.

---

## 4. Bucket configuration (operator task — never created by this app)

Required, on the Supabase project that backs the deployment:

* **One private bucket** named `STORAGE_BUCKET` (default `documents`), *public access
  off*. The app never uses public object URLs; nothing here creates a bucket.
* No permissive storage policies/RLS: the app acts with the service-role key server-side.
* **Global file-size limit ≥ 50 MiB.** This is the hard gate:
  | Plan | Max per-file upload | 50 MiB supported? |
  |---|---|---|
  | Supabase **Free** | 50 MB (not raisable) | **Yes** |
  | Supabase **Pro** and up | up to 500 GB | Yes |
  The application's 50 MiB limit matches the Free-tier cap. Set
  `STORAGE_PROVIDER_MAX_FILE_BYTES=52428800` for Free-tier deployments so oversized
  uploads are refused at intent time with an actionable message instead of failing
  mid-PUT with a provider error. `MAX_FILE_SIZE` plus its tests are the source of truth.
* Optional per-bucket MIME allow-list (`application/pdf`,
  `application/msword`, `application/vnd.openxmlformats-officedocument.*`,
  `application/vnd.ms-powerpoint`, `application/octet-stream`) — defence in depth only;
  the app's rules above are what the product enforces.

---

## 5. Lifecycle, cleanup and what is *not* implemented

* **Idempotency.** PUT to a signed URL overwrites-or-conflicts at one fixed key, so a
  client retry of the same file is safe; `complete` is idempotent per §2.2; a
  A `PENDING` row is re-completable within its window. A `PENDING` row that carries an
  `orderId` (only possible from the removed intent path) is refused at completion
  (`INTENT_NO_LONGER_VALID`) and is removed by the expiry sweep.
* **No orphan promotion.** A row is only usable when the app has verified the object at
  the key it generated. A row without a verified object can never be ordered, priced or
  printed.
* **Reaping.** `releaseExpiredIntents(limit=50)` deletes expired PENDING rows and their
  objects. The same endpoint also purges unordered documents after 24 hours and order
  documents after `retentionDays` (see DATABASE.md, "Data retention"). It is exposed as
  `POST /api/admin/uploads/sweep?limit=N` (SUPER_ADMIN, or the `CRON_SECRET` bearer for a
  scheduler) because the application has no scheduler. **A deployment that never calls it will accumulate
  abandoned objects.** If you need automatic expiry, either schedule that call (cron,
  GitHub Actions, Vercel Cron — all outside this codebase) or enable Supabase's own
  lifecycle rules for the bucket.
* **Not implemented, and not claimed:** malware scanning (`ENABLE_MALWARE_SCAN` is a dead
  flag), checksum-based integrity verification (the stored `checksum` is a
  verification fingerprint of the probed bytes, not a SHA-256 of the file), resumable /
  chunked uploads (see §6), per-bucket size enforcement, RLS policies.

---

## 6. Upload transfer mechanics

* **Single PUT, no chunking.** Supabase signed upload URLs are not multipart and are
  fixed to a 2-hour lifetime server-side (our own `UPLOAD_INTENT_TTL_SECONDS` is the
  tighter bound). A 50 MB PUT is therefore one request: no pause, and a network drop
  means restarting that file.
* **TUS/resumable is deliberately not used.** Supabase's documented
  "signed TUS" flow (`x-signature` with the createSignedUploadUrl token) has been
  reported failing with `403 Invalid Compact JWS` (supabase/agent-skills#580), and the
  TUS path otherwise requires a user access token, which this application does not
  issue (custom cookie sessions). Adding a `tus-js-client` dependency + service-role
  exposure would be the alternative; it is out of scope and would need its own audit.
* **No custom request headers beyond `Content-Type: text/plain;charset=UTF-8`.** The
  signed URL carries the token in its query string, so the PUT stays a CORS-simple
  request. The stored object's MIME type in Supabase is therefore `text/plain`; the
  application records and serves the **validated** MIME from the database row, which is
  what `Content-Disposition`/`Content-Type` on our download route use. Do not "fix" the
  provider-side type by adding an `Authorization` header: that turns a simple request
  into a preflighted one and would require the storage host to allow it.
* **Progress** comes from `XMLHttpRequest.upload.onprogress` (`src/lib/direct-upload.ts`).

---

## 7. Configuration reference for this flow

| Variable | Default | Effect |
|---|---|---|
| `STORAGE_BACKEND` | `local` | `supabase` is required for direct uploads |
| `STORAGE_BUCKET` | `documents` | the one private bucket holding documents *and* the payment QR |
| `NEXT_PUBLIC_SUPABASE_URL` | — | must be `https://<ref>.supabase.co` **without** `/storage/v1` |
| `SUPABASE_SERVICE_ROLE_KEY` | — | server-only; used to sign upload/download URLs and to verify objects |
| `SESSION_SECRET` | — | HMAC key for intent tokens (also collection tokens) |
| `DIRECT_UPLOADS_ENABLED` | `true` | `false` = every direct endpoint 503s; only sane on hosts with no body cap |
| `UPLOAD_INTENT_TTL_SECONDS` | `600` | completable window (60–3600) |
| `SIGNED_DOWNLOAD_URL_TTL_SECONDS` | `60` | signed read URL lifetime (10–900) |
| `STORAGE_PROVIDER_MAX_FILE_BYTES` | `0` | provider's own per-file cap; `0` = app limit binds |
| `RATE_LIMIT_STORAGE` + Upstash pair | `memory` | **required `redis`** for multi-instance hosts, else limits are per-instance |

`npm run config:check` (run with `NODE_ENV=production`) validates the https/`/storage`
shape of the Supabase URL, that direct uploads are not disabled, the two TTL ranges, and
the provider cap — see §"Deployment" in `DEPLOYMENT.md`. It cannot verify that the bucket
exists, is private, or has its file-size limit raised; that stays a checklist item.

---

## 8. Verification status (honest scope)

Covered by `npm test`: the token/format/expiry rules, size boundary at exactly 50 MiB,
type/signature rejections, cross-user access attempts, verification outcomes
(missing/oversized/size-mismatched/bad-signature), idempotent completion, outage
behaviour, orphan reaping, download authorization, and that signed URLs never appear in
audit metadata or error responses.

**Not covered by any automated run:** a real Supabase project. The REST shapes above come
from Supabase's current API and the `@supabase/storage-js` implementation
(`createSignedUploadUrl` → `PUT /object/upload/sign/{bucket}/{path}?token=…`,
`createSignedUrl` → `POST /object/sign/{bucket}/{path}`), but every one of them is an
*assumption* until it has been exercised against a live bucket.

### 8.1 Manual pre-production checklist

Run these against the **staging bucket** before the first production deploy, and again
after any Supabase plan change. Each one is a property this application relies on but
cannot enforce:

| # | Check | How | Fails how, if wrong |
|---|---|---|---|
| 1 | The bucket is private | `GET {SUPABASE_URL}/storage/v1/object/public/{bucket}/{key}` with no credentials, using an uploaded key | Documents are world-readable the moment a key is guessed — the entire model collapses |
| 2 | A signed upload URL writes **only** to its own path | `PUT` to a *different* key with token A | A credential leak becomes a write-anywhere primitive in the bucket |
| 3 | An existing object is **not** overwritten | `PUT` twice to the same key | One user's document could silently replace another's |
| 4 | `expiresIn` is honoured | mint an intent, wait past `UPLOAD_INTENT_TTL_SECONDS`, `PUT` | Uploads stay open indefinitely after an abandoned tab |
| 5 | `metadata.size` in `GET /object/info` is exact | upload a file of a known size, compare with `psql`/API | Completion accepts a padded or truncated object, or rejects good ones |
| 6 | A signed **download** URL is useless without its token | strip `?token=` from a download URL | `GET /api/files/:id/download` becomes a redirect to an attacker-followable URL |
| 7 | The range header works on a >4.5 MB object | `PUT` 20 MB through the browser, then confirm the 16-byte signature probe succeeds | Every upload 404s/500s at completion while the bytes are actually fine |
| 8 | The bucket's global per-file limit matches `STORAGE_PROVIDER_MAX_FILE_BYTES` | upload one byte over the configured cap | Users get a provider 413 that our UI cannot explain |
| 9 | CORS allows `PUT` from the app origin **without** custom headers | browser devtools on a real upload | Pre-flight fails; the wizard silently falls back to a proxy path that cannot carry the file |

Only after 1–9 pass should the feature be considered live. `POST /api/uploads/*` will
report 200/4xx all day long against a bucket that fails check 1, because the app never
looks at the public URL.

### 8.2 Deliberately not implemented

**Resumable / chunked uploads (TUS).** A resumable protocol solves a different problem
(weak mobile networks, very large files) and needs a server that accepts chunks — which is
exactly what this change removes. Adding it later means a real session store keyed by
upload id and a provider that honours partial uploads; neither exists here. A single PUT
under a signed URL is the honest scope of this feature.

**Malware scanning.** The verification step proves the object *is* the kind of file it
claims to be, at the size we authorized, at the key we chose. It does not prove the file is
safe to open. `ENABLE_MALWARE_SCAN` remains a flag with no code behind it (`SECURITY.md`
§11.2), and nothing in this flow should be read as a substitute for a scanner.
