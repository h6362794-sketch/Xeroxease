// Direct-to-storage uploads — the database + storage half of the protocol.
//
// All decisions live in `./policy.ts` (pure, unit-testable). This file only talks to
// Prisma and the storage adapter, and it never reads a byte of the document itself:
// the transfer happens browser → storage. What we do read at completion is the object's
// *metadata* (measured size) and its first bytes (signature), both taken from storage —
// never from the client.
//
// Invariants this module must hold, and where they are enforced:
//   * only the owner may create/complete/abort an intent  → ownership-scoped queries
//   * completion requires a token bound to this exact row → policy.uploadTokenMatchesRow
//   * an intent cannot outlive its window                 → intent_expires_at + claim.exp
//   * a document is only "usable" once storage agrees    → status flips to COMPLETED
//     after size + signature verification, and `createOrder` refuses anything else
//   * a failed verification never leaves a printable orphan → object deleted on
//     SIZE_MISMATCH / SIGNATURE_MISMATCH / TOO_LARGE, row set to FAILED
//   * a storage outage never corrupts state               → row stays PENDING, 5xx

import { prisma } from "@/lib/prisma";
import { MAX_FILE_SIZE, MAX_FILES_PER_ORDER } from "@/lib/constants";
import type { UploadIntent } from "@/lib/direct-upload";
import { env } from "@/server/env";
import { audit } from "@/server/audit";
import {
  SIGNATURE_PROBE_BYTES,
  decideCompletion,
  decideUploadIntent,
  intentTtlSeconds,
  issueUploadIntentGrant,
  normalizeDeclaredSize,
  uploadTokenMatchesRow,
  verifyIntentToken,
} from "./policy";
import {
  buildStorageKey,
  deleteFile,
  getStoredObjectInfo,
  readHeader,
  type StoredObjectInfo,
} from "@/server/storage";
import { DeploymentCapabilityError, directUploadsSupported } from "./capability";
import { createSignedUploadTarget } from "./storage-bridge";

export class UploadServiceError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = "UPLOAD_INTENT_REJECTED") {
    super(message);
    this.name = "UploadServiceError";
    this.status = status;
    this.code = code;
  }
}

interface SessionActor {
  id: string;
  role: "STUDENT" | "ADMIN" | "SUPER_ADMIN";
}

/** The subset of `uploaded_files` this module needs. */
interface FileRowLike {
  id: string;
  uploaderId: string;
  storageKey: string | null;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string | null;
  status: string;
  intentExpiresAt: Date | null;
  intentTokenHash: string | null;
}

const FILE_SELECT = {
  id: true,
  uploaderId: true,
  storageKey: true,
  originalName: true,
  mimeType: true,
  sizeBytes: true,
  checksum: true,
  status: true,
  intentExpiresAt: true,
  intentTokenHash: true,
} as const;

/**
 * The intent response, typed against the browser contract in `src/lib/direct-upload.ts`
 * so the two cannot drift apart silently: a field added here that the client does not
 * know about is a field nobody reads, and a field the client reads that we stopped
 * sending is an undefined-at-runtime bug.
 */
export type CreatedUploadIntent = UploadIntent;

/**
 * Step 1 — authorize an upload. Creates the PENDING document row, mints the object key
 * and asks storage for a single-path upload authorization for that key.
 */
export async function createUploadIntent(params: {
  actor: SessionActor;
  filename: string;
  declaredMime: string;
  declaredSizeRaw: unknown;
  orderId?: string | null;
}): Promise<CreatedUploadIntent> {
  const capability = directUploadsSupported();
  if (!capability.enabled) {
    throw new DeploymentCapabilityError(capability);
  }

  const sizeBytes = normalizeDeclaredSize(params.declaredSizeRaw);

  if (params.orderId) {
    const order = await prisma.order.findFirst({
      where: { id: params.orderId, userId: params.actor.id },
      select: { id: true },
    });
    if (!order) {
      throw new UploadServiceError("Order not found.", 404, "ORDER_NOT_FOUND");
    }
  }

  // Quota uses the same rule as the proxy route: at most MAX_FILES_PER_ORDER documents
  // may sit unattached to an order per user. Expired intents do not hold a slot.
  const inProgress = await prisma.uploadedFile.count({
    where: {
      uploaderId: params.actor.id,
      orderId: null,
      OR: [{ intentExpiresAt: null }, { intentExpiresAt: { gt: new Date() } }],
    },
  });

  const decision = decideUploadIntent({
    filename: params.filename,
    declaredMime: params.declaredMime,
    sizeBytes,
    fileCountInProgress: inProgress,
    maxFilesPerOrder: MAX_FILES_PER_ORDER,
  });
  if (!decision.ok) {
    throw new UploadServiceError(decision.error, decision.status, decision.code ?? "UPLOAD_INTENT_REJECTED");
  }

  const ttl = intentTtlSeconds();
  const storageKey = buildStorageKey(params.actor.id, decision.safeName);

  const created = await prisma.uploadedFile.create({
    data: {
      uploaderId: params.actor.id,
      orderId: params.orderId ?? null,
      originalName: decision.safeName.slice(0, 255),
      storageKey,
      mimeType: decision.mime,
      sizeBytes: sizeBytes ?? 0,
      // PENDING, not COMPLETED: nothing is printable until verification succeeds.
      status: "PENDING",
      analysisStatus: "PENDING",
      intentExpiresAt: new Date(Date.now() + ttl * 1000),
      intentTokenHash: null,
    },
    select: { id: true },
  });

  const grant = issueUploadIntentGrant({
    fileId: created.id,
    uploaderId: params.actor.id,
    storageKey,
    sizeBytes: sizeBytes ?? 0,
    ttlSeconds: ttl,
  });

  await prisma.uploadedFile.update({
    where: { id: created.id },
    data: { intentTokenHash: grant.tokenHash, intentExpiresAt: grant.expiresAt },
  });

  const target = await createSignedUploadTarget(storageKey, { expiresInSec: ttl });

  await audit({
    actorId: params.actor.id,
    actorRole: params.actor.role,
    action: "UPLOAD_INTENT_ISSUED",
    targetType: "FILE",
    targetId: created.id,
    // Size and type only. Never the token, never the signed URL, never the key.
    metadata: { sizeBytes: sizeBytes ?? 0, ext: decision.ext, ttlSeconds: ttl },
  });

  const providerCap = env.STORAGE_PROVIDER_MAX_FILE_BYTES;
  return {
    fileId: created.id,
    token: grant.token,
    uploadUrl: target.uploadUrl,
    method: "PUT",
    headers: {},
    expiresAt: grant.expiresAt.toISOString(),
    maxBytes: MAX_FILE_SIZE,
    proxyUploadAvailable: false,
    fileSizeLimitNote:
      providerCap > 0 && providerCap < MAX_FILE_SIZE
        ? `The storage provider's configured per-file limit is ${Math.floor(providerCap / (1024 * 1024))} MB, below the application's 100 MB.`
        : null,
  };
}

export interface CompletedUpload {
  fileId: string;
  status: "COMPLETED";
  sizeBytes: number;
  originalName: string;
  mimeType: string;
  verified: boolean;
}

/**
 * Step 3 — verify and accept. Everything below is decided from what *storage* reports;
 * the request body carries only a file id and the completion token.
 */
export async function completeUploadIntent(params: {
  actor: SessionActor;
  fileId: string;
  token: unknown;
}): Promise<CompletedUpload> {
  const capability = directUploadsSupported();
  if (!capability.enabled) {
    throw new DeploymentCapabilityError(capability);
  }
  if (typeof params.token !== "string" || params.token.length === 0) {
    throw new UploadServiceError("A completion token is required.", 400, "TOKEN_MISMATCH");
  }

  const file = (await prisma.uploadedFile.findFirst({
    where: { id: params.fileId, uploaderId: params.actor.id },
    select: FILE_SELECT,
  })) as FileRowLike | null;
  if (!file) {
    // Identical answer whether it does not exist or belongs to someone else.
    throw new UploadServiceError("Document not found.", 404, "NOT_FOUND");
  }

  const verifiedToken = verifyIntentToken(params.token);
  if (!verifiedToken.ok) {
    throw new UploadServiceError("That upload could not be verified. Please start again.", 400, "TOKEN_INVALID");
  }
  if (!uploadTokenMatchesRow(verifiedToken.claim, params.token, file)) {
    throw new UploadServiceError("That upload could not be verified. Please start again.", 403, "TOKEN_MISMATCH");
  }

  let info: StoredObjectInfo | null;
  let headerBytes: Uint8Array | null;
  try {
    info = await getStoredObjectInfo(file.storageKey!);
    headerBytes = info === null ? null : await readHeader(file.storageKey!, SIGNATURE_PROBE_BYTES);
  } catch (err) {
    // Storage outage: the row keeps its PENDING status and its live intent, so the
    // client can simply retry. Marking it FAILED here would punish a transient fault.
    console.error("[direct-upload] verification read failed", {
      fileId: file.id,
      message: err instanceof Error ? err.message : String(err),
    });
    throw new UploadServiceError("Storage is unavailable. Please try again shortly.", 503, "STORAGE_UNAVAILABLE");
  }

  const decision = decideCompletion({
    file,
    claim: verifiedToken.claim,
    info,
    headerBytes,
    actorId: params.actor.id,
  });

  if (!decision.ok) {
    if (decision.deleteObject && file.storageKey) {
      // Best effort: an object we refused must not linger in the bucket.
      await deleteFile(file.storageKey).catch(() => undefined);
    }
    if (decision.code !== "FORBIDDEN") {
      await prisma.uploadedFile
        .update({ where: { id: file.id }, data: { status: "FAILED", analysisStatus: "FAILED" } })
        .catch(() => undefined);
    }
    await audit({
      actorId: params.actor.id,
      actorRole: params.actor.role,
      action: "UPLOAD_COMPLETION_REJECTED",
      targetType: "FILE",
      targetId: file.id,
      // Codes only — never a token, key or signed URL.
      metadata: { code: decision.code, status: decision.status },
    });
    throw new UploadServiceError(decision.error, decision.status, decision.code);
  }

  if (decision.alreadyCompleted) {
    // Idempotent retry of a completed upload: report the same success, touch nothing.
    return {
      fileId: file.id,
      status: "COMPLETED",
      sizeBytes: file.sizeBytes,
      originalName: file.originalName,
      mimeType: file.mimeType,
      verified: true,
    };
  }

  try {
    await prisma.$transaction(async (tx: any) => {
      const updated = (await tx.uploadedFile.updateMany({
        where: { id: file.id, status: "PENDING", intentTokenHash: file.intentTokenHash },
        data: {
          status: "COMPLETED",
          sizeBytes: decision.verifiedSizeBytes,
          mimeType: decision.mimeType,
          checksum: decision.checksum,
          verifiedAt: new Date(),
          intentExpiresAt: null,
        },
      })) as { count: number };
      if (updated.count !== 1) {
        throw new UploadServiceError("This upload has already been processed.", 409, "ALREADY_COMPLETED");
      }
    });
  } catch (err) {
    // A failed write must not leave a verified-but-unusable inconsistency: the object
    // stays where it is so the retry path works, but it is only *claimed* printable
    // once the row actually says COMPLETED.
    if (err instanceof UploadServiceError) throw err;
    console.error("[direct-upload] completion persist failed", {
      fileId: file.id,
      message: err instanceof Error ? err.message : String(err),
    });
    throw new UploadServiceError("Could not record the upload. Please try again.", 503, "PERSIST_FAILED");
  }

  await audit({
    actorId: params.actor.id,
    actorRole: params.actor.role,
    action: "UPLOAD_COMPLETED",
    targetType: "FILE",
    targetId: file.id,
    metadata: { sizeBytes: decision.verifiedSizeBytes },
  });

  return {
    fileId: file.id,
    status: "COMPLETED",
    sizeBytes: decision.verifiedSizeBytes,
    originalName: file.originalName,
    mimeType: decision.mimeType,
    verified: true,
  };
}

/**
 * Release an intent the user no longer wants (browser tab closed, wrong file). Only the
 * owner may abort, and only while the document is still unattached and unverified.
 */
export async function abortUploadIntent(params: { actor: SessionActor; fileId: string }): Promise<{ released: boolean }> {
  const file = (await prisma.uploadedFile.findFirst({
    where: { id: params.fileId, uploaderId: params.actor.id },
    select: FILE_SELECT,
  })) as FileRowLike | null;
  if (!file) throw new UploadServiceError("Document not found.", 404, "NOT_FOUND");
  if (file.status === "COMPLETED") {
    throw new UploadServiceError("This document is already verified and remains attached to your order.", 409, "ALREADY_COMPLETED");
  }

  if (file.storageKey) {
    await deleteFile(file.storageKey).catch(() => undefined);
  }
  await prisma.uploadedFile.deleteMany({ where: { id: file.id, uploaderId: params.actor.id, status: "PENDING" } });

  await audit({
    actorId: params.actor.id,
    actorRole: params.actor.role,
    action: "UPLOAD_ABORTED",
    targetType: "FILE",
    targetId: file.id,
  });
  return { released: true };
}

export interface IntentSweepReport {
  released: number;
  attempted: number;
  /** Present when the sweep stopped early; the rest are released on the next run. */
  cappedAt?: number;
}

/**
 * Garbage collection for abandoned uploads: an expired PENDING row plus whatever object
 * it left behind. There is no cron in this application by design, so this runs from the
 * Super Admin console (POST /api/admin/uploads/sweep) and is safe to call repeatedly.
 */
export async function releaseExpiredIntents(limit = 50): Promise<IntentSweepReport> {
  const capped = Math.max(1, Math.min(500, limit));
  const stale = await prisma.uploadedFile.findMany({
    where: { status: "PENDING", intentExpiresAt: { lt: new Date() } },
    select: { id: true, storageKey: true, uploaderId: true },
    take: capped + 1,
  });
  const rows = stale.slice(0, capped);
  let released = 0;
  for (const row of rows) {
    if (row.storageKey) await deleteFile(row.storageKey).catch(() => undefined);
    // Delete only the row, never the object an order may already reference: an order
    // can only attach COMPLETED files, so a PENDING row here is always orphan-safe.
    const res = (await prisma.uploadedFile.deleteMany({
      where: { id: row.id, status: "PENDING" },
    })) as { count: number };
    if (res.count > 0) released++;
  }
  if (rows.length > 0) {
    await audit({
      actorId: null,
      actorRole: "SYSTEM",
      action: "UPLOAD_INTENTS_REAPED",
      targetType: "FILE",
      // No targetId: a sweep is not about one row, and inventing an id would make the
      // audit trail look like it was.
      metadata: { released, attempted: rows.length },
    });
  }
  return { released, attempted: rows.length, ...(stale.length > capped ? { cappedAt: capped } : {}) };
}
