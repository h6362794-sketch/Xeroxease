import { prisma } from "@/lib/prisma";
import { requireUser } from "@/server/auth";
import { apiError, enforceRateLimit, json, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { validateUpload, hasDoubleExtension } from "@/server/file-validation";
import { buildStorageKey, saveBuffer, readHeader } from "@/server/storage";
import { MAX_FILES_PER_ORDER } from "@/lib/constants";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();

    const limited = enforceRateLimit(req, RATE_LIMITS.upload, "upload");
    if (limited) return limited;

    const contentType = req.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return apiError("Expected multipart form data.", 415);
    }

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return apiError("No file provided.", 400);

    // Content-Length guard
    const declaredSize = Number(req.headers.get("content-length") || 0);
    if (declaredSize > 110 * 1024 * 1024) {
      return apiError("Upload too large.", 413);
    }

    const filename = file.name || "upload";
    if (hasDoubleExtension(filename)) {
      return apiError("Suspicious filename rejected.", 400);
    }

    const buf = Buffer.from(await file.arrayBuffer());

    // Read magic bytes from the actual stored buffer.
    const header = buf.subarray(0, 16);
    const validation = validateUpload(filename, file.type || "", buf.length, header);
    if (!validation.ok) return apiError(validation.error || "Invalid file.", 400);

    // Count existing files for this user in open state (soft per-order limit)
    const existingCount = await prisma.uploadedFile.count({
      where: { uploaderId: user.id, orderId: null },
    });
    if (existingCount >= MAX_FILES_PER_ORDER) {
      return apiError(`You can attach up to ${MAX_FILES_PER_ORDER} files per order.`, 409);
    }

    const storageKey = buildStorageKey(user.id, validation.ext ? filename : "file");
    await saveBuffer(storageKey, buf);

    const record = await prisma.uploadedFile.create({
      data: {
        uploaderId: user.id,
        originalName: filename.slice(0, 255),
        storageKey,
        mimeType: validation.mime,
        sizeBytes: buf.length,
        status: "COMPLETED",
        analysisStatus: "PENDING",
      },
      select: { id: true, originalName: true, sizeBytes: true, mimeType: true, analysisStatus: true },
    });

    return json({ file: record }, { status: 201 });
  });
}

export const dynamic = "force-dynamic";
