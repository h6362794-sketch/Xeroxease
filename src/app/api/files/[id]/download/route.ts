import { prisma } from "@/lib/prisma";
import { requireUser, isAdminRole } from "@/server/auth";
import { apiError, enforceRateLimit, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { StorageError, openStream } from "@/server/storage";
import {
  authorizeDownload,
  downloadRedirectHeaders,
  NOT_FOUND_MESSAGE,
  signedDownloadTtlSeconds,
  shouldSignDownload,
  dispositionFor,
} from "@/server/direct-upload/download";
import { normalizeDownloadMode } from "@/server/direct-upload/policy";
import { createSignedDownloadUrl } from "@/server/direct-upload/storage-bridge";

/**
 * GET /api/files/:id/download
 *
 * Authorization always happens here, from the database row. What happens *next*
 * depends on the storage backend:
 *
 *  * `supabase` (production / Vercel) → 307 redirect to a short-lived, object-specific
 *    signed URL. The bytes travel browser ↔ storage, never through a function body,
 *    so a 100 MB document works and the function stays O(1) in memory.
 *  * `local` (development) → streamed response, because the local backend cannot hand
 *    the browser any credential. Streaming rather than buffering also keeps the
 *    download route honest about the size ceiling it is meant to remove.
 *
 * A verification-failed or never-verified document is never served, even to an admin.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const limited = await enforceRateLimit(req, RATE_LIMITS.download, "download", user.id);
    if (limited) return limited;

    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return apiError("Invalid file id.", 400);

    const file = await prisma.uploadedFile.findUnique({
      where: { id },
      select: { id: true, uploaderId: true, originalName: true, storageKey: true, status: true, mimeType: true },
    });

    const decision = authorizeDownload(file, { id: user.id, role: user.role }, isAdminRole);
    if (!decision.allowed) {
      // Same answer for "not yours" and "no such file": not an existence oracle.
      return apiError(NOT_FOUND_MESSAGE, 404);
    }
    if (decision.file.status !== "COMPLETED") return apiError(NOT_FOUND_MESSAGE, 404);
    const storageKey = decision.file.storageKey;
    if (!storageKey) return apiError(NOT_FOUND_MESSAGE, 404);

    const url = new URL(req.url);
    const mode = normalizeDownloadMode(url.searchParams.get("mode"));

    if (shouldSignDownload()) {
      try {
        const signed = await createSignedDownloadUrl(storageKey, {
          expiresInSec: signedDownloadTtlSeconds(),
          download: dispositionFor(mode) ? decision.file.originalName : undefined,
        });
        return new Response(null, {
          status: 307,
          headers: { Location: signed.url, ...downloadRedirectHeaders() },
        });
      } catch (err) {
        // A storage outage must not turn into "we will quietly buffer the file for you"
        // (that path cannot work at this size) nor leak the provider's error text.
        const status = err instanceof StorageError ? err.status : 502;
        console.error("[download] signing failed", { fileId: decision.file.id, status });
        return apiError("Downloads are temporarily unavailable. Please try again.", 503, "DOWNLOAD_UNAVAILABLE");
      }
    }

    try {
      const stream = await openStream(storageKey);
      const asWeb =
        stream instanceof ReadableStream
          ? stream
          : new ReadableStream<Uint8Array>({
              start(controller) {
                stream.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
                stream.on("end", () => controller.close());
                stream.on("error", (err: unknown) => controller.error(err));
              },
            });
      return new Response(asWeb, {
        headers: {
          "Content-Type": decision.file.mimeType || "application/octet-stream",
          "Content-Disposition": `${mode === "view" ? "inline" : "attachment"}; filename="${encodeURIComponent(
            decision.file.originalName
          )}"`,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return apiError(NOT_FOUND_MESSAGE, 404);
    }
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
