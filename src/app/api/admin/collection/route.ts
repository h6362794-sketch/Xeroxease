import { prisma } from "@/lib/prisma";
import { requireRole } from "@/server/auth";
import { apiError, json, parseBody, withErrorHandling } from "@/server/api-utils";
import { verifyCollectionToken } from "@/server/collection";
import { audit } from "@/server/audit";
import { z } from "zod";

const schema = z.object({ token: z.string().min(10).max(120), consume: z.boolean().default(false) });

export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireRole("ADMIN", "SUPER_ADMIN");
    const data = await parseBody(req, schema);

    const result = await verifyCollectionToken(data.token, data.consume === true);
    if (!result.ok) return apiError(result.reason || "Invalid collection code.", 400);

    const order = await prisma.order.findUnique({
      where: { id: result.orderId! },
      include: { user: { select: { name: true, regNo: true } } },
    });

    if (data.consume) {
      // Complete the order as part of verified collection.
      const { adminUpdateOrderStatus } = await import("@/server/orders");
      await adminUpdateOrderStatus({
        orderId: order!.id,
        toStatus: "COMPLETED",
        actorId: user.id,
        actorRole: user.role,
        note: "Collected via QR verification.",
      });
      await audit({
        actorId: user.id,
        actorRole: user.role,
        action: "ORDER_COLLECTED_VIA_QR",
        targetType: "ORDER",
        targetId: order!.id,
        metadata: { orderNumber: order!.orderNumber },
      });
    }

    return json({
      ok: true,
      consumed: data.consume,
      order: order
        ? {
            id: order.id,
            orderNumber: order.orderNumber,
            studentName: order.user.name,
            regNo: order.user.regNo,
            status: order.status,
          }
        : null,
    });
  });
}

export const dynamic = "force-dynamic";
