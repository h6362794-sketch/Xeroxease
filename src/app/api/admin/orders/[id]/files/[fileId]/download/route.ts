import { prisma } from "@/lib/prisma";
import { requireRole } from "@/server/auth";
import { apiError, enforceRateLimit, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { StorageError, openStream } from "@/server/storage";
import {
  downloadRedirectHeaders,
  shouldSignDownload,
  signedDownloadTtlSeconds,
} from "@/server/direct-upload/download";
import { normalizeDownloadMode } from "@/server/direct-upload/policy";
import { createSignedDownloadUrl } from "@/server/direct-upload/storage-bridge";
import { authorizeAdminOrderFile, safeContentDisposition } from "@/lib/order-file-access";

/**
 * GET /api/admin/orders/:id/files/:fileId/download?mode=view|download
 *
 * Order-scoped administrator document access. The file must be attached to the
 * requested order and owned by that order's student; every negative case returns
 * the same 404, so ids cannot be probed. On Supabase the response is a 307 to a
 * short-lived signed URL; locally the bytes are streamed. The bucket stays private
 * and no storage key ever reaches the client.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> }
) {
  return withErrorHandling(async () => {
    const user = await requireRole("ADMIN", "SUPER_ADMIN");
    const limited = await enforceRateLimit(req, RATE_LIMITS.download, "admin-order-file", user.id);
    if (limited) return limited;

    const { id, fileId } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(fileId)) {
      return apiError("File not found.", 404, "FILE_NOT_FOUND");
    }

    const [order, file] = await Promise.all([
      prisma.order.findUnique({ where: { id }, select: { id: true, userId: true } }),
      prisma.uploadedFile.findUnique({
        where: { id: fileId },
        select: {
          id: true,
          orderId: true,
          uploaderId: true,
          status: true,
          storageKey: true,
          originalName: true,
          mimeType: true,
          sizeBytes: true,
        },
      }),
    ]);

    const decision = authorizeAdminOrderFile({ file, order, actorRole: user.role });
    if (!decision.allowed) {
      if (decision.reason === "unverified") {
        console.warn("[admin-file] refused unverified document", { orderId: id, fileId, actorId: user.id });
      }
      return apiError("File not found.", 404, "FILE_NOT_FOUND");
    }

    const mode = normalizeDownloadMode(new URL(req.url).searchParams.get("mode"));

    if (shouldSignDownload()) {
      try {
        const signed = await createSignedDownloadUrl(file!.storageKey as string, {
          expiresInSec: signedDownloadTtlSeconds(),
          download: mode === "view" ? undefined : file!.originalName,
        });
        return new Response(null, {
          status: 307,
          headers: { Location: signed.url, ...downloadRedirectHeaders() },
        });
      } catch (err) {
        const status = err instanceof StorageError ? err.status : 502;
        console.error("[admin-file] signing failed", { orderId: id, fileId, status });
        return apiError(
          "Downloads are temporarily unavailable. Please try again.",
          503,
          "DOWNLOAD_UNAVAILABLE"
        );
      }
    }

    try {
      const stream = await openStream(file!.storageKey as string);
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
          "Content-Type": file!.mimeType || "application/octet-stream",
          "Content-Disposition": safeContentDisposition(file!.originalName, mode),
          "Content-Length": String(file!.sizeBytes),
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
        },
      });
    } catch (err) {
      console.error("[admin-file] stream failed", {
        orderId: id,
        fileId,
        message: err instanceof Error ? err.message : "unknown",
      });
      return apiError("File is no longer available.", 404, "FILE_NOT_FOUND");
    }
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
