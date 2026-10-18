import { prisma } from "@/lib/prisma";
import { requireUser } from "@/server/auth";
import { apiError, enforceRateLimit, json, parseBody, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { paymentSubmitSchema } from "@/server/validation";
import { audit } from "@/server/audit";
import { notify, NOTIFY } from "@/server/notifications";
import { OrderError, TERMINAL_ORDER_STATES } from "@/server/orders";
import { DUPLICATE_REFERENCE_MESSAGE, isPaymentReferenceConflict } from "@/server/payment-reference";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const limited = await enforceRateLimit(req, RATE_LIMITS.paymentSubmit, "pay-submit");
    if (limited) return limited;

    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return apiError("Invalid order id.", 400);

    const data = await parseBody(req, paymentSubmitSchema);

    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) return apiError("Order not found.", 404);
    if (order.userId !== user.id) return apiError("You can only submit payment for your own orders.", 403);
    // Cancelled, failed or completed orders keep their payment fields. Without this check a
    // submission would move the order back into review, reviving a cancelled order.
    if ((TERMINAL_ORDER_STATES as readonly string[]).includes(order.status)) {
      return apiError("This order is no longer open for payment.", 409);
    }

    // Idempotency & duplicate protection
    if (order.paymentStatus === "PAYMENT_CONFIRMED") {
      return apiError("Payment for this order is already confirmed.", 409);
    }
    if (order.paymentStatus === "PAYMENT_UNDER_REVIEW" || order.paymentStatus === "PAYMENT_PROOF_SUBMITTED") {
      return json({ ok: true, message: "Payment already submitted and under review.", duplicate: true });
    }
    if (!["PAYMENT_PENDING", "PAYMENT_REJECTED", "PAYMENT_FAILED"].includes(order.paymentStatus)) {
      return apiError("Payment cannot be submitted in the current order state.", 409);
    }

    // Conditional write: the payment state is re-checked inside the same statement that
    // changes it, so two concurrent submissions cannot both move the order into review.
    // The reference is unique across orders (see migration 20261018000000); a reuse is
    // rejected here with a clear message and, if a race beats this check, by the index.
    try {
      await prisma.$transaction(async (tx) => {
        const reused = await tx.order.findFirst({
          where: { paymentRef: data.reference, NOT: { id: order.id } },
          select: { id: true },
        });
        if (reused) throw new OrderError(DUPLICATE_REFERENCE_MESSAGE, 409);

        const { count } = await tx.order.updateMany({
          where: {
            id: order.id,
            userId: user.id,
            paymentStatus: { in: ["PAYMENT_PENDING", "PAYMENT_REJECTED", "PAYMENT_FAILED"] },
            status: { notIn: [...TERMINAL_ORDER_STATES] },
          },
          data: {
            paymentStatus: "PAYMENT_UNDER_REVIEW",
            status: "PAYMENT_UNDER_REVIEW",
            paymentRef: data.reference,
            paymentProofAt: new Date(),
          },
        });
        if (count !== 1) {
          throw new OrderError("Payment state changed while you were submitting. Refresh and try again.", 409);
        }
        await tx.paymentEvent.create({
          data: {
            orderId: order.id,
            actorId: user.id,
            actorRole: "STUDENT",
            type: "SUBMITTED",
            amount: order.totalAmount,
            reference: data.reference,
          },
        });
        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            type: "PAYMENT_SUBMITTED",
            fromStatus: order.status,
            toStatus: "PAYMENT_UNDER_REVIEW",
            message: "Payment reference submitted by student.",
            actorId: user.id,
            actorRole: "STUDENT",
          },
        });
      });
    } catch (err) {
      if (isPaymentReferenceConflict(err)) return apiError(DUPLICATE_REFERENCE_MESSAGE, 409);
      throw err;
    }

    await NOTIFY.paymentSubmitted(user.id, order.orderNumber, order.id);
    await audit({
      actorId: user.id,
      actorRole: "STUDENT",
      action: "PAYMENT_SUBMITTED",
      targetType: "ORDER",
      targetId: order.id,
      metadata: { orderNumber: order.orderNumber, referenceLast4: data.reference.slice(-4) },
    });

    // Notify all admins (in-app)
    const admins = await prisma.user.findMany({
      where: { role: { in: ["ADMIN", "SUPER_ADMIN"] }, isActive: true },
      select: { id: true },
    });
    await Promise.all(
      admins.map((a) =>
        notify({
          userId: a.id,
          type: "PAYMENT_SUBMITTED",
          title: "Payment to verify",
          body: `${order.orderNumber} — payment reference submitted and awaiting review.`,
          orderId: order.id,
        })
      )
    );

    return json({ ok: true, message: "Payment submitted. Verification is pending with the print desk." });
  });
}

export const dynamic = "force-dynamic";
