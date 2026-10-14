import { prisma } from "@/lib/prisma";
import { requireUser, isAdminRole } from "@/server/auth";
import { apiError, json, withErrorHandling } from "@/server/api-utils";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return apiError("Invalid order id.", 400);

    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        files: {
          select: {
            id: true,
            originalName: true,
            sizeBytes: true,
            pageCount: true,
            pageCountSource: true,
            analysisStatus: true,
            analysisError: true,
            mimeType: true,
          },
        },
        events: { orderBy: { createdAt: "asc" } },
        feedback: { select: { id: true, rating: true, comment: true, createdAt: true } },
        user: { select: { name: true, email: true, regNo: true, phone: true, branch: true, section: true, year: true } },
      },
    });
    if (!order) return apiError("Order not found.", 404);

    const isAdmin = isAdminRole(user.role);
    if (order.userId !== user.id && !isAdmin) {
      return apiError("You do not have access to this order.", 403);
    }

    const hasCollectionToken = Boolean(order.collectionTokenHash) && !order.collectionTokenUsedAt;

    return json({
      order: {
        ...order,
        totalAmount: Number(order.totalAmount),
        pricePerPage: Number(order.pricePerPage),
        finishingFee: Number(order.finishingFee),
        collectionToken: null, // raw token never leaves server
        hasCollectionToken,
        user: isAdmin ? order.user : undefined,
      },
    });
  });
}

export const dynamic = "force-dynamic";
