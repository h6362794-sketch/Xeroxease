import { prisma } from "@/lib/prisma";
import { requireRole } from "@/server/auth";
import { apiError, parseBody, withErrorHandling } from "@/server/api-utils";
import { z } from "zod";
import { audit } from "@/server/audit";
import { NOTIFY } from "@/server/notifications";

const schema = z.object({ note: z.string().trim().max(500).optional().or(z.literal("")) });

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  return withErrorHandling(async () => {
    const user = await requireRole("ADMIN", "SUPER_ADMIN");
    const { id } = params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return apiError("Invalid order id.", 400);
    const data = await parseBody(req, schema);

    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) return apiError("Order not found.", 404);
    if (order.paymentStatus === "PAYMENT_CONFIRMED") {
      return Response.json({ ok: true, idempotent: true });
    }
    if (!["PAYMENT_PROOF_SUBMITTED", "PAYMENT_UNDER_REVIEW"].includes(order.paymentStatus)) {
      return apiError("Payment is not in a verifiable state.", 409);
    }

    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: {
          paymentStatus: "PAYMENT_CONFIRMED",
          status: "PAYMENT_CONFIRMED",
          paymentVerifiedBy: user.id,
          paymentVerifiedAt: new Date(),
          paymentNote: data.note || null,
        },
      });
      await tx.paymentEvent.create({
        data: {
          orderId: order.id,
          actorId: user.id,
          actorRole: user.role,
          type: "VERIFIED",
          amount: order.totalAmount,
          reference: order.paymentRef,
          note: data.note || null,
        },
      });
      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          type: "PAYMENT_VERIFIED",
          fromStatus: order.status,
          toStatus: "PAYMENT_CONFIRMED",
          actorId: user.id,
          actorRole: user.role,
        },
      });
    });

    await NOTIFY.paymentConfirmed(order.userId, order.orderNumber, order.id);
    await audit({
      actorId: user.id,
      actorRole: user.role,
      action: "PAYMENT_VERIFIED",
      targetType: "ORDER",
      targetId: order.id,
      metadata: { orderNumber: order.orderNumber },
    });

    return Response.json({ ok: true });
  });
}

export const dynamic = "force-dynamic";
