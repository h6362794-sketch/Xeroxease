import { prisma } from "@/lib/prisma";
import { requireUser } from "@/server/auth";
import { apiError, json, withErrorHandling } from "@/server/api-utils";
import { signCollectionToken } from "@/server/collection";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { id } = params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return apiError("Invalid order id.", 400);

    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) return apiError("Order not found.", 404);
    if (order.userId !== user.id) return apiError("You do not have access to this order.", 403);
    if (order.status !== "READY_FOR_COLLECTION") {
      return apiError("Collection code is available once the order is ready for collection.", 409);
    }

    // Ensure a token hash exists (defensive re-attach).
    if (!order.collectionTokenHash) {
      await (await import("@/server/collection")).attachCollectionToken(order.id);
    }

    return json({
      orderNumber: order.orderNumber,
      token: signCollectionToken(order.id),
      used: Boolean(order.collectionTokenUsedAt),
    });
  });
}

export const dynamic = "force-dynamic";
