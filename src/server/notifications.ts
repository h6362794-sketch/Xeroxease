import { prisma } from "@/lib/prisma";
import type { NotificationType } from "@prisma/client";

export async function notify(params: {
  userId: string;
  type: NotificationType;
  title: string;
  body?: string;
  orderId?: string;
}): Promise<void> {
  try {
    await prisma.notification.create({
      data: {
        userId: params.userId,
        type: params.type,
        title: params.title,
        body: params.body,
        orderId: params.orderId,
      },
    });
  } catch (err) {
    console.error("[notify] failed", err instanceof Error ? err.message : err);
  }
}

export const NOTIFY = {
  orderCreated: (userId: string, orderNumber: string, orderId: string) =>
    notify({
      userId,
      type: "ORDER_CREATED",
      title: "Order received",
      body: `Your order ${orderNumber} has been received.`,
      orderId,
    }),
  paymentSubmitted: (userId: string, orderNumber: string, orderId: string) =>
    notify({
      userId,
      type: "PAYMENT_SUBMITTED",
      title: "Payment submitted",
      body: `Payment for ${orderNumber} is under review.`,
      orderId,
    }),
  paymentConfirmed: (userId: string, orderNumber: string, orderId: string) =>
    notify({
      userId,
      type: "PAYMENT_CONFIRMED",
      title: "Payment confirmed",
      body: `Payment for ${orderNumber} has been confirmed.`,
      orderId,
    }),
  paymentRejected: (userId: string, orderNumber: string, orderId: string) =>
    notify({
      userId,
      type: "PAYMENT_REJECTED",
      title: "Payment rejected",
      body: `Payment for ${orderNumber} was rejected. Please contact support or resubmit.`,
      orderId,
    }),
  statusUpdate: (userId: string, orderNumber: string, statusLabel: string, orderId: string) =>
    notify({
      userId,
      type: "ORDER_STATUS",
      title: "Order update",
      body: `Your order ${orderNumber} is now ${statusLabel}.`,
      orderId,
    }),
  orderReady: (userId: string, orderNumber: string, orderId: string) =>
    notify({
      userId,
      type: "ORDER_READY",
      title: "Order ready for collection",
      body: `Your order ${orderNumber} is ready. Show the collection QR at the counter.`,
      orderId,
    }),
  orderCompleted: (userId: string, orderNumber: string, orderId: string) =>
    notify({
      userId,
      type: "ORDER_COMPLETED",
      title: "Order completed",
      body: `Your order ${orderNumber} has been completed. Rate your experience!`,
      orderId,
    }),
  orderCancelled: (userId: string, orderNumber: string, orderId: string) =>
    notify({
      userId,
      type: "ORDER_CANCELLED",
      title: "Order cancelled",
      body: `Your order ${orderNumber} has been cancelled.`,
      orderId,
    }),
  orderRejected: (userId: string, orderNumber: string, reason: string, orderId: string) =>
    notify({
      userId,
      type: "ORDER_REJECTED",
      title: "Order not accepted",
      body: `Your order ${orderNumber} was not accepted by the print desk.${reason ? ` Reason: ${reason}` : ""}`,
      orderId,
    }),
  orderAccepted: (userId: string, orderNumber: string, orderId: string) =>
    notify({
      userId,
      type: "ORDER_ACCEPTED",
      title: "Order accepted",
      body: `Your order ${orderNumber} has been accepted for printing. Payment options are now available.`,
      orderId,
    }),
};
