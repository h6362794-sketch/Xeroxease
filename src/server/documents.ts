import { prisma } from "@/lib/prisma";
import { audit } from "./audit";

export class DocumentError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export const MAX_CONFIRMED_PAGE_COUNT = 10_000;

/**
 * Record a human-confirmed page count for a document whose automatic analysis was
 * inconclusive (NEEDS_REVIEW) or failed.
 *
 * This is the exit from the "explicit review state" required by the analysis engine:
 * without it, an unparseable .doc or a metadata-less .docx would block ordering with
 * no self-service remedy. Ownership is always enforced so a caller can only confirm
 * counts for their own documents.
 */
export async function confirmFilePageCount(params: {
  fileId: string;
  userId: string;
  pageCount: number;
}): Promise<{ id: string; pageCount: number | null }> {
  const { fileId, userId, pageCount } = params;

  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > MAX_CONFIRMED_PAGE_COUNT) {
    throw new DocumentError(
      `Page count must be a whole number between 1 and ${MAX_CONFIRMED_PAGE_COUNT}.`,
      400
    );
  }

  const file = await prisma.uploadedFile.findFirst({ where: { id: fileId, uploaderId: userId } });
  if (!file) {
    throw new DocumentError("Document not found.", 404);
  }
  if (file.orderId) {
    throw new DocumentError(
      "This document is already attached to an order and can no longer be edited.",
      409
    );
  }
  if (file.analysisStatus === "PENDING" || file.analysisStatus === "PROCESSING") {
    throw new DocumentError("Analysis is still running. Please wait a moment.", 409);
  }

  const updated = await prisma.uploadedFile.update({
    where: { id: file.id },
    data: {
      pageCount,
      pageCountSource: "USER_CONFIRMED",
      analysisStatus: "COMPLETED",
      analysisError: null,
      analyzedAt: new Date(),
    },
    select: { id: true, pageCount: true },
  });

  await audit({
    actorId: userId,
    actorRole: "STUDENT",
    action: "PAGE_COUNT_CONFIRMED_BY_USER",
    targetType: "FILE",
    targetId: file.id,
    metadata: { previous: file.pageCount, confirmed: pageCount, previousStatus: file.analysisStatus },
  });

  return updated;
}
