import { prisma } from "@/lib/prisma";
import { requireUser } from "@/server/auth";
import { apiError, enforceRateLimit, json, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { validateUpload, hasDoubleExtension, sanitizeFilename } from "@/server/file-validation";
import { buildStorageKey, deleteFile, saveBuffer } from "@/server/storage";
import { MAX_FILE_SIZE, MAX_FILES_PER_ORDER } from "@/lib/constants";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Multipart overhead (boundaries + headers) on top of a single file.
 * Content-Length is only a hint from the client — it is checked early to reject
 * obviously oversized bodies, and the real byte length is enforced afterwards.
 */
const MULTIPART_OVERHEAD_BYTES = 8 * 1024;
const MAX_DECLARED_BODY_BYTES = MAX_FILE_SIZE + MULTIPART_OVERHEAD_BYTES;

export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();

    const limited = await enforceRateLimit(req, RATE_LIMITS.upload, "upload");
    if (limited) return limited;

    const contentType = req.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      return apiError("Expected multipart form data.", 415);
    }

    // Reject oversized bodies BEFORE parsing, so the request never reaches the
    // multipart parser (and never buffers the payload in memory).
    const declaredSize = Number(req.headers.get("content-length") || "0");
    if (Number.isFinite(declaredSize) && declaredSize > MAX_DECLARED_BODY_BYTES) {
      return apiError(`Upload too large. Maximum file size is ${Math.floor(MAX_FILE_SIZE / (1024 * 1024))} MB.`, 413);
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return apiError("Malformed or interrupted upload. Please try again.", 400);
    }

    // Only one file per request is supported; extra parts are rejected rather than
    // silently ignored.
    const entries = form.getAll("file");
    if (entries.length !== 1) {
      return apiError(entries.length === 0 ? "No file provided." : "Only one file may be uploaded per request.", 400);
    }
    const file = entries[0];
    if (!(file instanceof File)) return apiError("No file provided.", 400);

    const filename = file.name || "upload";
    if (hasDoubleExtension(filename)) {
      return apiError("Suspicious filename rejected.", 400);
    }

    // Defensive: stop parsing/streaming if the client lied about Content-Length.
    if (file.size > MAX_FILE_SIZE) {
      return apiError(`Upload too large. Maximum file size is ${Math.floor(MAX_FILE_SIZE / (1024 * 1024))} MB.`, 413);
    }

    const buf = Buffer.from(await file.arrayBuffer());
    // Authoritative size check on the bytes actually received.
    if (buf.length === 0) return apiError("Empty file.", 400);
    if (buf.length > MAX_FILE_SIZE) {
      return apiError(`Upload too large. Maximum file size is ${Math.floor(MAX_FILE_SIZE / (1024 * 1024))} MB.`, 413);
    }

    // Magic-byte (file signature) check on the real bytes, not just the extension.
    const header = buf.subarray(0, 16);
    const validation = validateUpload(filename, file.type || "", buf.length, header);
    if (!validation.ok) return apiError(validation.error || "Invalid file.", 400);

    // Soft per-order file limit.
    const existingCount = await prisma.uploadedFile.count({
      where: { uploaderId: user.id, orderId: null },
    });
    if (existingCount >= MAX_FILES_PER_ORDER) {
      return apiError(`You can attach up to ${MAX_FILES_PER_ORDER} files per order.`, 409);
    }

    const safeName = sanitizeFilename(filename);
    const storageKey = buildStorageKey(user.id, safeName);
    await saveBuffer(storageKey, buf);

    try {
      const record = await prisma.uploadedFile.create({
        data: {
          uploaderId: user.id,
          originalName: safeName.slice(0, 255),
          storageKey,
          mimeType: validation.mime,
          sizeBytes: buf.length,
          status: "COMPLETED",
          analysisStatus: "PENDING",
        },
        select: { id: true, originalName: true, sizeBytes: true, mimeType: true, analysisStatus: true },
      });
      return json({ file: record }, { status: 201 });
    } catch (err) {
      // No orphaned objects and no "success" for a file that has no database row.
      await deleteFile(storageKey).catch((cleanupErr) =>
        console.error("[uploads] failed to remove orphaned object", storageKey, cleanupErr)
      );
      throw err;
    }
  });
}

export const dynamic = "force-dynamic";
