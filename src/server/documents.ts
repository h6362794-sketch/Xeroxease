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
  // Self-service confirmation is an exit from the review state ONLY. A count the
  // parser produced (COMPLETED from DOCUMENT_PARSER) or an administrator set is what
  // the order is priced from, so the student may not overwrite it. Previously this
  // route accepted any count for any owned, unattached document, which let a 100-page
  // PDF be ordered as 1 page. The same rule is enforced atomically in the WHERE clause
  // below, so a concurrent analysis or order cannot race past the check.
  const inReview = file.analysisStatus === "NEEDS_REVIEW" || file.analysisStatus === "FAILED";
  // A student may correct their own earlier confirmation (a typo). This never widens
  // trust: a USER_CONFIRMED source only ever exists on a review-state document.
  const correctingOwnConfirmation = file.pageCountSource === "USER_CONFIRMED";
  if (!inReview && !correctingOwnConfirmation) {
    throw new DocumentError(
      "This page count was verified automatically and cannot be changed. Ask the print desk if it is wrong.",
      409
    );
  }

  const { count } = await prisma.uploadedFile.updateMany({
    where: {
      id: file.id,
      uploaderId: userId,
      orderId: null,
      OR: [
        { analysisStatus: { in: ["NEEDS_REVIEW", "FAILED"] } },
        { pageCountSource: "USER_CONFIRMED" },
      ],
    },
    data: {
      pageCount,
      pageCountSource: "USER_CONFIRMED",
      analysisStatus: "COMPLETED",
      analysisError: null,
      analyzedAt: new Date(),
    },
  });
  if (count !== 1) {
    throw new DocumentError(
      "This document changed while you were editing it. Refresh and try again.",
      409
    );
  }
  const updated = { id: file.id, pageCount };

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
