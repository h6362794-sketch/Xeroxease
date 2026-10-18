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

    // Desk-only fields never reach a student: internal notes, who verified or cancelled
    // the order, the collection-token digest, and the admin actor ids on the timeline.
    const studentView = isAdmin
      ? {}
      : {
          adminNotes: null,
          paymentVerifiedBy: null,
          paymentNote: null,
          cancelledBy: null,
          collectionTokenHash: null,
          events: order.events.map((e) => ({ ...e, actorId: null, actorRole: null })),
        };

    return json({
      order: {
        ...order,
        ...studentView,
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
