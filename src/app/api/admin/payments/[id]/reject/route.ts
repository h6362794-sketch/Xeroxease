import { prisma } from "@/lib/prisma";
import { requireRole } from "@/server/auth";
import { apiError, parseBody, withErrorHandling } from "@/server/api-utils";
import { z } from "zod";
import { audit } from "@/server/audit";
import { NOTIFY } from "@/server/notifications";

const schema = z.object({
  note: z.string().trim().min(3, "A rejection note is required.").max(500),
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  return withErrorHandling(async () => {
    const user = await requireRole("ADMIN", "SUPER_ADMIN");
    const { id } = params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return apiError("Invalid order id.", 400);
    const data = await parseBody(req, schema);

    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) return apiError("Order not found.", 404);
    if (!["PAYMENT_PROOF_SUBMITTED", "PAYMENT_UNDER_REVIEW"].includes(order.paymentStatus)) {
      return apiError("Payment is not in a rejectable state.", 409);
    }

    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: {
          paymentStatus: "PAYMENT_REJECTED",
          status: "PAYMENT_PENDING", // back to pending so student can resubmit
          paymentNote: data.note,
        },
      });
      await tx.paymentEvent.create({
        data: {
          orderId: order.id,
          actorId: user.id,
          actorRole: user.role,
          type: "REJECTED",
          reference: order.paymentRef,
          note: data.note,
        },
      });
      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          type: "PAYMENT_REJECTED",
          fromStatus: order.status,
          toStatus: "PAYMENT_PENDING",
          message: data.note,
          actorId: user.id,
          actorRole: user.role,
        },
      });
    });

    await NOTIFY.paymentRejected(order.userId, order.orderNumber, order.id);
    await audit({
      actorId: user.id,
      actorRole: user.role,
      action: "PAYMENT_REJECTED",
      targetType: "ORDER",
      targetId: order.id,
      metadata: { orderNumber: order.orderNumber, reason: data.note },
    });

    return Response.json({ ok: true });
  });
}

export const dynamic = "force-dynamic";
