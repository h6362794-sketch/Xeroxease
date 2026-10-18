import { prisma } from "@/lib/prisma";
import { requireRole } from "@/server/auth";
import { apiError, parseBody, withErrorHandling } from "@/server/api-utils";
import { z } from "zod";
import { audit } from "@/server/audit";
import { NOTIFY } from "@/server/notifications";
import { OrderError, TERMINAL_ORDER_STATES, VERIFIABLE_PAYMENT_STATES } from "@/server/orders";

const schema = z.object({
  note: z.string().trim().min(3, "A rejection note is required.").max(500),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withErrorHandling(async () => {
    const user = await requireRole("ADMIN", "SUPER_ADMIN");
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return apiError("Invalid order id.", 400);
    const data = await parseBody(req, schema);

    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) return apiError("Order not found.", 404);
    if (!["PAYMENT_PROOF_SUBMITTED", "PAYMENT_UNDER_REVIEW"].includes(order.paymentStatus)) {
      return apiError("Payment is not in a rejectable state.", 409);
    }

    try {
      await prisma.$transaction(async (tx) => {
        const { count } = await tx.order.updateMany({
          where: {
            id: order.id,
            paymentStatus: { in: [...VERIFIABLE_PAYMENT_STATES] },
            status: { notIn: [...TERMINAL_ORDER_STATES] },
          },
          data: {
            paymentStatus: "PAYMENT_REJECTED",
            status: "PAYMENT_PENDING", // back to pending so student can resubmit
            paymentNote: data.note,
          },
        });
        if (count !== 1) {
          throw new OrderError("This order changed while you were reviewing it. Refresh and check its current state.", 409);
        }
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
    } catch (err) {
      if (err instanceof OrderError) return apiError(err.message, err.status);
      throw err;
    }

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
