// Payment service — server-authoritative payment state transitions.
//
// Payment is a SEPARATE axis from the print lifecycle:
//   * selecting cash or submitting a UPI reference never confirms money;
//   * verifying/rejecting writes only payment fields (and PaymentEvent history),
//     never `Order.status`;
//   * every mutation is a conditional update on the state that was read, so
//     duplicate or racing admin decisions cannot double-confirm an order;
//   * only ADMIN/SUPER_ADMIN can confirm or reject.

import { prisma } from "@/lib/prisma";
import { audit } from "./audit";
import { NOTIFY, notify } from "./notifications";
import { canActorChangeStatus } from "@/lib/order-status";
import {
  canAdminRejectPayment,
  canAdminVerifyPayment,
  canChangePaymentMethod,
  canStudentSubmitUpiReference,
  isPaymentMethod,
  normalizeUpiReference,
  type PaymentMethod,
} from "@/lib/payment-policy";
import { PAYMENT_ELIGIBLE_ORDER_STATUSES } from "@/lib/order-status";

export class PaymentError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const ELIGIBLE_ORDER_STATUSES: readonly string[] = PAYMENT_ELIGIBLE_ORDER_STATUSES;

/**
 * Student chooses how they will pay, after acceptance.
 * This does not touch PaymentStatus beyond leaving it PENDING (cash) or keeping
 * an already-rejected state visible, and it never marks the order paid.
 */
export async function selectPaymentMethod(params: {
  orderId: string;
  userId: string;
  method: unknown;
}): Promise<{ method: PaymentMethod }> {
  if (!isPaymentMethod(params.method)) {
    throw new PaymentError("Choose either Cash on Delivery or UPI.", 422);
  }
  // Capture the narrowed value: `params.method` widens back to `unknown` inside
  // the transaction closure, because TypeScript cannot rule out a later write.
  const method: PaymentMethod = params.method;
  const order = await prisma.order.findUnique({ where: { id: params.orderId } });
  if (!order) throw new PaymentError("Order not found.", 404);
  if (order.userId !== params.userId) {
    throw new PaymentError("You can only manage payment for your own orders.", 403);
  }

  const decision = canChangePaymentMethod({
    orderStatus: order.status,
    paymentStatus: order.paymentStatus,
    currentMethod: order.paymentMethod ?? null,
    nextMethod: method,
  });
  if (!decision.ok) throw new PaymentError(decision.message, decision.status);

  const applied = await prisma.$transaction(async (tx) => {
    const updated = await tx.order.updateMany({
      where: {
        id: order.id,
        userId: params.userId,
        status: { in: ELIGIBLE_ORDER_STATUSES as never },
        paymentStatus: { not: "PAYMENT_CONFIRMED" as never },
      },
      data: {
        paymentMethod: method,
      } as never,
    });
    if (updated.count !== 1) return false;

    await tx.paymentEvent.create({
      data: {
        orderId: order.id,
        actorId: params.userId,
        actorRole: "STUDENT",
        type: "METHOD_SELECTED",
        amount: order.totalAmount,
        reference: order.paymentRef,
        note: method,
      },
    });
    return true;
  });

  if (!applied) {
    throw new PaymentError(
      "This order changed while you were selecting a payment method. Refresh the page and try again.",
      409
    );
  }

  await audit({
    actorId: params.userId,
    actorRole: "STUDENT",
    action: "PAYMENT_METHOD_SELECTED",
    targetType: "ORDER",
    targetId: order.id,
    metadata: { orderNumber: order.orderNumber, method },
  });

  return { method };
}

/**
 * Student submits a UPI transaction reference. This is a CLAIM, not proof:
 * payment status becomes UNDER_REVIEW and nothing is marked paid.
 */
export async function submitUpiReference(params: {
  orderId: string;
  userId: string;
  reference: unknown;
}): Promise<{ reference: string }> {
  const normalized = normalizeUpiReference(params.reference);
  if (!normalized.ok) throw new PaymentError(normalized.message, 422);

  const order = await prisma.order.findUnique({ where: { id: params.orderId } });
  if (!order) throw new PaymentError("Order not found.", 404);
  if (order.userId !== params.userId) {
    throw new PaymentError("You can only submit payment for your own orders.", 403);
  }

  const decision = canStudentSubmitUpiReference({
    orderStatus: order.status,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod ?? null,
  });
  if (!decision.ok) throw new PaymentError(decision.message, decision.status);

  const now = new Date();
  const applied = await prisma.$transaction(async (tx) => {
    const updated = await tx.order.updateMany({
      where: {
        id: order.id,
        userId: params.userId,
        paymentMethod: "UPI",
        status: { in: ELIGIBLE_ORDER_STATUSES as never },
        paymentStatus: { in: ["PAYMENT_PENDING", "PAYMENT_REJECTED", "PAYMENT_FAILED"] as never },
      },
      data: {
        paymentStatus: "PAYMENT_UNDER_REVIEW",
        paymentRef: normalized.value,
        paymentProofAt: now,
        // A resubmission after rejection starts a fresh review; the rejection
        // reason stays visible in PaymentEvent history.
        paymentNote: null,
      } as never,
    });
    if (updated.count !== 1) return false;

    await tx.paymentEvent.create({
      data: {
        orderId: order.id,
        actorId: params.userId,
        actorRole: "STUDENT",
        type: "SUBMITTED",
        amount: order.totalAmount,
        reference: normalized.value,
      },
    });
    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        type: "PAYMENT_SUBMITTED",
        fromStatus: order.status,
        toStatus: order.status,
        message: "UPI payment reference submitted by student; awaiting verification.",
        actorId: params.userId,
        actorRole: "STUDENT",
      },
    });
    return true;
  });

  if (!applied) {
    throw new PaymentError(
      "Payment for this order changed while you were submitting. Refresh the page and try again.",
      409
    );
  }

  await NOTIFY.paymentSubmitted(params.userId, order.orderNumber, order.id);
  await audit({
    actorId: params.userId,
    actorRole: "STUDENT",
    action: "PAYMENT_SUBMITTED",
    targetType: "ORDER",
    targetId: order.id,
    metadata: { orderNumber: order.orderNumber, referenceLast4: normalized.value.slice(-4) },
  });

  // In-app alert for the desk (no external messaging service).
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
        body: `${order.orderNumber} — a UPI reference was submitted and awaits verification.`,
        orderId: order.id,
      })
    )
  );

  return { reference: normalized.value };
}

/**
 * Admin confirms money was actually received. Cash at pickup and UPI after a
 * manual statement check both land here; the actor, timestamp, amount and
 * reference are recorded, and the order's printing status is untouched.
 */
export async function verifyPayment(params: {
  orderId: string;
  actorId: string;
  actorRole: string;
  note?: string;
}): Promise<void> {
  if (!canActorChangeStatus(params.actorRole)) {
    throw new PaymentError("Only an administrator can confirm payments.", 403);
  }

  const order = await prisma.order.findUnique({ where: { id: params.orderId } });
  if (!order) throw new PaymentError("Order not found.", 404);

  const decision = canAdminVerifyPayment({
    orderStatus: order.status,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod ?? null,
    paymentRef: order.paymentRef ?? null,
  });
  if (!decision.ok) throw new PaymentError(decision.message, decision.status);

  const note = params.note?.trim() || null;
  const now = new Date();
  const isCash = order.paymentMethod === "CASH_ON_DELIVERY";

  const applied = await prisma.$transaction(async (tx) => {
    const updated = await tx.order.updateMany({
      where: {
        id: order.id,
        paymentStatus: {
          in: ["PAYMENT_PENDING", "PAYMENT_PROOF_SUBMITTED", "PAYMENT_UNDER_REVIEW"] as never,
        },
        paymentMethod: { not: null },
        status: { in: [...ELIGIBLE_ORDER_STATUSES, "DELIVERED"] as never },
        ...(isCash ? {} : { paymentRef: { not: null } }),
      },
      data: {
        paymentStatus: "PAYMENT_CONFIRMED",
        paymentVerifiedBy: params.actorId,
        paymentVerifiedAt: now,
        paymentNote: note,
      } as never,
    });
    if (updated.count !== 1) return false;

    await tx.paymentEvent.create({
      data: {
        orderId: order.id,
        actorId: params.actorId,
        actorRole: params.actorRole,
        type: isCash ? "CASH_RECEIVED" : "VERIFIED",
        amount: order.totalAmount,
        reference: order.paymentRef,
        note,
      },
    });
    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        type: "PAYMENT_VERIFIED",
        fromStatus: order.status,
        toStatus: order.status,
        message: isCash ? "Cash payment received by the print desk." : "UPI payment verified by the print desk.",
        actorId: params.actorId,
        actorRole: params.actorRole,
      },
    });
    return true;
  });

  if (!applied) {
    throw new PaymentError(
      "Payment for this order was already updated. Refresh the page before trying again.",
      409
    );
  }

  await NOTIFY.paymentConfirmed(order.userId, order.orderNumber, order.id);
  await audit({
    actorId: params.actorId,
    actorRole: params.actorRole,
    action: "PAYMENT_VERIFIED",
    targetType: "ORDER",
    targetId: order.id,
    metadata: {
      orderNumber: order.orderNumber,
      method: order.paymentMethod,
      amount: Number(order.totalAmount),
      note,
    },
  });
}

/**
 * Admin rejects a submitted payment. A reason is mandatory, the reference stays
 * in history, and the student may resubmit after correcting it. No refund or
 * reversal is attempted here.
 */
export async function rejectPayment(params: {
  orderId: string;
  actorId: string;
  actorRole: string;
  reason: string;
}): Promise<void> {
  if (!canActorChangeStatus(params.actorRole)) {
    throw new PaymentError("Only an administrator can reject payments.", 403);
  }
  const order = await prisma.order.findUnique({ where: { id: params.orderId } });
  if (!order) throw new PaymentError("Order not found.", 404);

  const decision = canAdminRejectPayment({
    paymentStatus: order.paymentStatus,
    reason: params.reason,
  });
  if (!decision.ok) throw new PaymentError(decision.message, decision.status);

  const reason = params.reason.trim();
  const applied = await prisma.$transaction(async (tx) => {
    const updated = await tx.order.updateMany({
      where: {
        id: order.id,
        status: { in: ELIGIBLE_ORDER_STATUSES as never },
        paymentStatus: { in: ["PAYMENT_PROOF_SUBMITTED", "PAYMENT_UNDER_REVIEW"] as never },
      },
      data: {
        paymentStatus: "PAYMENT_REJECTED",
        paymentNote: reason,
      } as never,
    });
    if (updated.count !== 1) return false;

    await tx.paymentEvent.create({
      data: {
        orderId: order.id,
        actorId: params.actorId,
        actorRole: params.actorRole,
        type: "REJECTED",
        amount: order.totalAmount,
        reference: order.paymentRef,
        note: reason,
      },
    });
    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        type: "PAYMENT_REJECTED",
        fromStatus: order.status,
        toStatus: order.status,
        message: reason,
        actorId: params.actorId,
        actorRole: params.actorRole,
      },
    });
    return true;
  });

  if (!applied) {
    throw new PaymentError(
      "Payment for this order was already updated. Refresh the page before trying again.",
      409
    );
  }

  await NOTIFY.paymentRejected(order.userId, order.orderNumber, order.id);
  await audit({
    actorId: params.actorId,
    actorRole: params.actorRole,
    action: "PAYMENT_REJECTED",
    targetType: "ORDER",
    targetId: order.id,
    metadata: { orderNumber: order.orderNumber, reason },
  });
}
