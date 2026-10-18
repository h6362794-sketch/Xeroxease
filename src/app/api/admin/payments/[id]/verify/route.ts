import { prisma } from "@/lib/prisma";
import { requireRole } from "@/server/auth";
import { apiError, parseBody, withErrorHandling } from "@/server/api-utils";
import { z } from "zod";
import { audit } from "@/server/audit";
import { NOTIFY } from "@/server/notifications";
import { OrderError, PAYMENT_DECISION_ORDER_STATES, VERIFIABLE_PAYMENT_STATES } from "@/server/orders";
import { isTransitionAllowed } from "@/lib/order-status";

const schema = z.object({ note: z.string().trim().max(500).optional().or(z.literal("")) });

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withErrorHandling(async () => {
    const user = await requireRole("ADMIN", "SUPER_ADMIN");
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return apiError("Invalid order id.", 400);
    const data = await parseBody(req, schema);

    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) return apiError("Order not found.", 404);
    if (order.paymentStatus === "PAYMENT_CONFIRMED") {
      return Response.json({ ok: true, idempotent: true });
    }
    if (!isTransitionAllowed(order.status, "PAYMENT_CONFIRMED")) {
      return apiError(`This order is ${order.status.toLowerCase().replace(/_/g, " ")} and its payment cannot be verified.`, 409);
    }
    if (!(PAYMENT_DECISION_ORDER_STATES as readonly string[]).includes(order.status)) {
      return apiError(`This order is ${order.status.toLowerCase().replace(/_/g, " ")} and its payment cannot be verified.`, 409);
    }
    if (!["PAYMENT_PROOF_SUBMITTED", "PAYMENT_UNDER_REVIEW"].includes(order.paymentStatus)) {
      return apiError("Payment is not in a verifiable state.", 409);
    }

    // Conditional write. The payment must still be awaiting review AND the order must
    // still be live. Without the status guard, verifying an order the student had
    // already cancelled would silently revive it into the print queue.
    try {
      await prisma.$transaction(async (tx) => {
        const { count } = await tx.order.updateMany({
          where: {
            id: order.id,
            paymentStatus: { in: [...VERIFIABLE_PAYMENT_STATES] },
            status: { in: [...PAYMENT_DECISION_ORDER_STATES] },
          },
          data: {
            paymentStatus: "PAYMENT_CONFIRMED",
            status: "PAYMENT_CONFIRMED",
            paymentVerifiedBy: user.id,
            paymentVerifiedAt: new Date(),
            paymentNote: data.note || null,
          },
        });
        if (count !== 1) {
          throw new OrderError("This order changed while you were verifying it. Refresh and check its current state.", 409);
        }
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
    } catch (err) {
      if (err instanceof OrderError) return apiError(err.message, err.status);
      throw err;
    }

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
