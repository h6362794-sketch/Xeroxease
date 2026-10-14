import { prisma } from "@/lib/prisma";
import { requireRole } from "@/server/auth";
import { apiError, parseBody, withErrorHandling } from "@/server/api-utils";
import { pageCorrectionSchema } from "@/server/validation";
import { audit } from "@/server/audit";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> }
) {
  return withErrorHandling(async () => {
    const user = await requireRole("ADMIN", "SUPER_ADMIN");
    const { id, fileId } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(fileId)) {
      return apiError("Invalid identifiers.", 400);
    }

    const data = await parseBody(req, pageCorrectionSchema);

    const file = await prisma.uploadedFile.findFirst({
      where: { id: fileId, orderId: id },
    });
    if (!file) return apiError("File not found on this order.", 404);

    await prisma.uploadedFile.update({
      where: { id: file.id },
      data: {
        pageCount: data.pageCount,
        pageCountSource: "ADMIN_VERIFIED",
        analysisStatus: "COMPLETED",
        analyzedAt: new Date(),
      },
    });

    await audit({
      actorId: user.id,
      actorRole: user.role,
      action: "PAGE_COUNT_CORRECTED",
      targetType: "FILE",
      targetId: file.id,
      metadata: { orderId: id, previous: file.pageCount, corrected: data.pageCount },
    });

    return Response.json({ ok: true });
  });
}

export const dynamic = "force-dynamic";
