// Document lifecycle: how an uploaded document is removed.
//
// Three things end a document's life, and all three go through the same claim-then-delete
// sequence so that none of them can break an order or leave a live object unaccounted for:
//
//  1. The student removes an unattached document (DELETE /api/uploads/:id).
//  2. An unattached document is abandoned for longer than UNATTACHED_UPLOAD_TTL_HOURS.
//  3. An order's document is past the retention period (Settings → retention days) after the
//     order was completed, cancelled or failed.
//
// Claim-then-delete. For an unattached document the claim is `purgedAt` set while `orderId`
// is still null. createOrder links only documents whose `purgedAt` is null, so the race is
// decided by one conditional write: either the order links the file first (the claim matches
// nothing and the purge skips it), or the claim lands first (the order's link fails with 409).
// Only after the claim is the object deleted. If the object delete fails, the claim is released,
// nothing was removed, and the document stays available. Only then is the row deleted.
//
// Retention keeps the row (order history, page counts, invoices) and sets `purgedAt`. The
// download route refuses purged documents.

import { prisma } from "@/lib/prisma";
import { UNATTACHED_UPLOAD_TTL_HOURS } from "@/lib/constants";
import { deleteFile } from "./storage";
import { getSettings } from "./settings";
import { releaseExpiredIntents } from "./direct-upload/service";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type PurgeOutcome = "purged" | "not_found" | "failed";

/**
 * Delete one unattached document. `uploaderId`, when given, restricts the purge to that
 * student's own document (the student-facing route); the cleanup job passes nothing.
 */
export async function purgeUnattachedUpload(fileId: string, uploaderId?: string): Promise<PurgeOutcome> {
  const row = await prisma.uploadedFile.findFirst({
    where: { id: fileId, orderId: null, purgedAt: null, ...(uploaderId ? { uploaderId } : {}) },
    select: { storageKey: true },
  });
  if (!row) return "not_found";

  const claimedAt = new Date();
  const claim = await prisma.uploadedFile.updateMany({
    where: { id: fileId, orderId: null, purgedAt: null },
    data: { purgedAt: claimedAt },
  });
  if (claim.count !== 1) return "not_found";

  try {
    await deleteFile(row.storageKey);
  } catch {
    // Nothing was removed: release the claim so the document can be retried or attached.
    await prisma.uploadedFile.updateMany({
      where: { id: fileId, orderId: null, purgedAt: claimedAt },
      data: { purgedAt: null },
    });
    return "failed";
  }

  await prisma.uploadedFile.deleteMany({
    where: { id: fileId, orderId: null, purgedAt: claimedAt },
  });
  return "purged";
}

export interface UnattachedPurgeReport {
  attempted: number;
  purged: number;
  failed: number;
  leftoversRemoved: number;
}

/**
 * Remove unattached documents older than UNATTACHED_UPLOAD_TTL_HOURS, in-progress direct
 * uploads excepted (a PENDING row with a live intent is still being uploaded).
 */
export async function purgeAbandonedUploads(now: Date, limit: number): Promise<UnattachedPurgeReport> {
  const cutoff = new Date(now.getTime() - UNATTACHED_UPLOAD_TTL_HOURS * HOUR_MS);
  const stale = await prisma.uploadedFile.findMany({
    where: {
      orderId: null,
      purgedAt: null,
      createdAt: { lt: cutoff },
      OR: [{ status: { not: "PENDING" } }, { intentExpiresAt: null }, { intentExpiresAt: { lt: now } }],
    },
    select: { id: true },
    take: limit,
  });

  let purged = 0;
  let failed = 0;
  for (const row of stale) {
    const outcome = await purgeUnattachedUpload(row.id);
    if (outcome === "purged") purged++;
    else if (outcome === "failed") failed++;
  }

  // Rows whose object was deleted but whose row removal failed on an earlier run. They hold no
  // bytes and can never be attached, so they only need to be cleared.
  const leftovers = await prisma.uploadedFile.deleteMany({
    where: { orderId: null, purgedAt: { not: null, lt: cutoff } },
  });

  return { attempted: stale.length, purged, failed, leftoversRemoved: leftovers.count };
}

export interface RetentionReport {
  attempted: number;
  purged: number;
  failed: number;
  retentionDays: number;
}

/**
 * Delete the stored objects of order documents whose retention period has passed. The clock
 * starts when the order reaches a terminal state: completed, cancelled, or failed.
 */
export async function purgeRetainedDocuments(now: Date, limit: number): Promise<RetentionReport> {
  const { retentionDays } = await getSettings();
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  const due = await prisma.uploadedFile.findMany({
    where: {
      purgedAt: null,
      order: {
        is: {
          OR: [
            { status: "COMPLETED", completedAt: { lt: cutoff } },
            { status: "CANCELLED", cancelledAt: { lt: cutoff } },
            { status: "FAILED", updatedAt: { lt: cutoff } },
          ],
        },
      },
    },
    select: { id: true, storageKey: true },
    take: limit,
  });

  let purged = 0;
  let failed = 0;
  for (const row of due) {
    try {
      await deleteFile(row.storageKey);
    } catch {
      failed++;
      continue; // left in place; the next run retries it
    }
    await prisma.uploadedFile.updateMany({
      where: { id: row.id, purgedAt: null },
      data: { purgedAt: now },
    });
    purged++;
  }
  return { attempted: due.length, purged, failed, retentionDays };
}

export interface UploadSweepReport {
  /** Expired upload intents released (direct uploads only; 0 when that backend is off). */
  released: number;
  attempted: number;
  intentsFailed: number;
  unattachedAttempted: number;
  unattachedPurged: number;
  unattachedFailed: number;
  leftoversRemoved: number;
  retentionAttempted: number;
  retentionPurged: number;
  retentionFailed: number;
  retentionDays: number;
}

/**
 * One bounded, re-runnable pass over all three lifecycle jobs. Each job is capped at `limit`
 * rows per run, so a backlog drains over several runs rather than one long transaction.
 */
export async function runUploadSweep(
  options: { limit: number; intents: boolean },
  now: Date = new Date()
): Promise<UploadSweepReport> {
  const intents = options.intents
    ? await releaseExpiredIntents(options.limit)
    : { released: 0, attempted: 0, failed: 0 };
  const unattached = await purgeAbandonedUploads(now, options.limit);
  const retention = await purgeRetainedDocuments(now, options.limit);
  return {
    released: intents.released,
    attempted: intents.attempted,
    intentsFailed: intents.failed,
    unattachedAttempted: unattached.attempted,
    unattachedPurged: unattached.purged,
    unattachedFailed: unattached.failed,
    leftoversRemoved: unattached.leftoversRemoved,
    retentionAttempted: retention.attempted,
    retentionPurged: retention.purged,
    retentionFailed: retention.failed,
    retentionDays: retention.retentionDays,
  };
}
