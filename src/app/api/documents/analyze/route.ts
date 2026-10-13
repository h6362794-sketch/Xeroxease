import { prisma } from "@/lib/prisma";
import { requireUser } from "@/server/auth";
import { apiError, enforceRateLimit, json, parseBody, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { analyzeDocument } from "@/server/doc-analysis";
import { getExtension } from "@/server/file-validation";
import { z } from "zod";

const schema = z.object({ fileId: z.string().uuid() });

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

    await prisma.uploadedFile.update({
      where: { id: file.id },
      data: { analysisStatus: "PROCESSING" },
    });

    const ext = getExtension(file.originalName);
    const result = await analyzeDocument(file.storageKey, ext);

    await prisma.uploadedFile.update({
      where: { id: file.id },
      data: {
        pageCount: result.pageCount,
        pageCountSource: result.source,
        analysisStatus: result.status === "COMPLETED" ? "COMPLETED" : result.status,
        analysisError: result.error,
        analyzedAt: new Date(),
      },
    });

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
