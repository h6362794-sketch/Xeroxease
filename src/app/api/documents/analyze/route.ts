import { prisma } from "@/lib/prisma";
import { requireUser } from "@/server/auth";
import { apiError, enforceRateLimit, json, parseBody, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { analyzeDocument } from "@/server/doc-analysis";
import { getExtension } from "@/server/file-validation";
import { z } from "zod";

const schema = z.object({ fileId: z.string().uuid() });

// States in which analysis may still set the page count. COMPLETED is excluded: it is a verified
// count (parser, AI analysis, desk, or the student's own confirmation) that an order is priced from.
const REANALYSABLE_STATES = ["PENDING", "PROCESSING", "NEEDS_REVIEW", "FAILED"] as const;

export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const limited = await enforceRateLimit(req, RATE_LIMITS.analyze, "analyze");
    if (limited) return limited;

    const { fileId } = await parseBody(req, schema);

    const file = await prisma.uploadedFile.findFirst({
      where: { id: fileId, uploaderId: user.id },
    });
    if (!file) return apiError("File not found.", 404);
    if (file.purgedAt) return apiError("This document has been removed. Please upload it again.", 409);
    if (file.orderId) {
      return apiError("This document is already attached to an order and cannot be analysed again.", 409);
    }
    if (!(REANALYSABLE_STATES as readonly string[]).includes(file.analysisStatus)) {
      // A verified count (COMPLETED) is what the order is priced from. Re-analysis may not replace it.
      return apiError("This page count is already verified and cannot be analysed again.", 409);
    }

    // Claim the row before analysing. The claim is conditional on the state we checked, so a
    // concurrent order link or a second analysis cannot slip past the check above.
    const claim = await prisma.uploadedFile.updateMany({
      where: {
        id: file.id,
        uploaderId: user.id,
        orderId: null,
        purgedAt: null,
        analysisStatus: file.analysisStatus,
      },
      data: { analysisStatus: "PROCESSING" },
    });
    if (claim.count !== 1) {
      return apiError("This document changed while it was being analysed. Refresh and try again.", 409);
    }

    let result: Awaited<ReturnType<typeof analyzeDocument>>;
    try {
      const ext = getExtension(file.originalName);
      result = await analyzeDocument(file.storageKey, ext);
    } catch (err) {
      // Recoverable: put the row back where it was so the student can retry.
      await prisma.uploadedFile.updateMany({
        where: { id: file.id, analysisStatus: "PROCESSING", orderId: null },
        data: { analysisStatus: file.analysisStatus },
      });
      throw err;
    }

    // Write the result only if the row is still ours: still PROCESSING, still unordered, still not purged.
    const written = await prisma.uploadedFile.updateMany({
      where: { id: file.id, orderId: null, purgedAt: null, analysisStatus: "PROCESSING" },
      data: {
        pageCount: result.pageCount,
        pageCountSource: result.source,
        analysisStatus: result.status === "COMPLETED" ? "COMPLETED" : result.status,
        analysisError: result.error,
        analyzedAt: new Date(),
      },
    });
    if (written.count !== 1) {
      return apiError("This document changed while it was being analysed. Refresh and try again.", 409);
    }

    return json({
      fileId: file.id,
      pageCount: result.pageCount,
      source: result.source,
      status: result.status,
      error: result.error ?? null,
    });
  });
}

export const dynamic = "force-dynamic";
