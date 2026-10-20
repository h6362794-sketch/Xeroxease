import { prisma } from "@/lib/prisma";
import { getSessionUser, isAdminRole } from "@/server/auth";
import { apiError, enforceRateLimit, json, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";

/**
 * GET /api/admin/payments?state=PENDING_REVIEW|AWAITING_CASH|CONFIRMED|REJECTED
 *
 * Admin-only. Returns a bounded page (max 100) of payment rows, including the
 * method and the order lifecycle status so the desk can see where the order is.
 * The previous implementation computed a `where` clause and then never used it,
 * so every tab returned all orders.
 */
const PAYMENT_STATES = ["PENDING_REVIEW", "AWAITING_CASH", "CONFIRMED", "REJECTED"] as const;

export async function GET(req: Request) {
  return withErrorHandling(async () => {
    const user = await getSessionUser();
    if (!user || !isAdminRole(user.role)) return apiError("Forbidden.", 403);

    const limited = await enforceRateLimit(req, RATE_LIMITS.admin, "admin-payments", user.id);
    if (limited) return limited;

    const url = new URL(req.url);
    const state = url.searchParams.get("state") || "PENDING_REVIEW";
    if (!PAYMENT_STATES.includes(state as never)) {
      return apiError("Unknown payment state.", 400, "INVALID_STATE");
    }
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(100, Math.max(5, parseInt(url.searchParams.get("pageSize") || "50", 10) || 50));

    const where =
      state === "PENDING_REVIEW"
        ? { paymentStatus: { in: ["PAYMENT_PROOF_SUBMITTED", "PAYMENT_UNDER_REVIEW"] } }
        : state === "AWAITING_CASH"
        ? { paymentMethod: "CASH_ON_DELIVERY", paymentStatus: "PAYMENT_PENDING" }
        : state === "CONFIRMED"
        ? { paymentStatus: "PAYMENT_CONFIRMED" }
        : { paymentStatus: "PAYMENT_REJECTED" };

    const [total, orders] = await Promise.all([
      prisma.order.count({ where: where as never }),
      prisma.order.findMany({
        where: where as never,
        orderBy: [{ paymentProofAt: "desc" }, { createdAt: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { user: { select: { name: true, regNo: true, email: true, phone: true } } },
      }),
    ]);

    return json({
      total,
      page,
      pageSize,
      orders: orders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        student: o.user,
        amount: Number(o.totalAmount),
        orderStatus: o.status,
        paymentMethod: o.paymentMethod,
        paymentRef: o.paymentRef,
        paymentProofAt: o.paymentProofAt,
        paymentStatus: o.paymentStatus,
        paymentNote: o.paymentNote,
        paymentVerifiedAt: o.paymentVerifiedAt,
        createdAt: o.createdAt,
      })),
    });
  });
}

export const dynamic = "force-dynamic";
