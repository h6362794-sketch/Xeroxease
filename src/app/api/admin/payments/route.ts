import { prisma } from "@/lib/prisma";
import { getSessionUser, isAdminRole } from "@/server/auth";
import { apiError, json, withErrorHandling } from "@/server/api-utils";

export async function GET(req: Request) {
  return withErrorHandling(async () => {
    const user = await getSessionUser();
    if (!user || !isAdminRole(user.role)) return apiError("Forbidden.", 403);

    const url = new URL(req.url);
    const state = url.searchParams.get("state") || "PENDING_REVIEW";

    const where: Record<string, unknown> =
      state === "PENDING_REVIEW"
        ? { paymentStatus: { in: ["PAYMENT_PROOF_SUBMITTED", "PAYMENT_UNDER_REVIEW"] } }
        : state === "CONFIRMED"
        ? { paymentStatus: "PAYMENT_CONFIRMED" }
        : state === "REJECTED"
        ? { paymentStatus: "PAYMENT_REJECTED" }
        : {};

    const orders = await prisma.order.findMany({
      where,
      orderBy: { paymentProofAt: "desc" },
      take: 100,
      include: { user: { select: { name: true, regNo: true, email: true, phone: true } } },
    });

    return json({
      orders: orders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        student: o.user,
        amount: Number(o.totalAmount),
        paymentRef: o.paymentRef,
        paymentProofAt: o.paymentProofAt,
        paymentStatus: o.paymentStatus,
        paymentNote: o.paymentNote,
        createdAt: o.createdAt,
      })),
    });
  });
}

export const dynamic = "force-dynamic";
