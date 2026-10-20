import { prisma } from "@/lib/prisma";
import { getSessionUser, isAdminRole } from "@/server/auth";
import { apiError, json, withErrorHandling } from "@/server/api-utils";
import { runWithDbConcurrency } from "@/server/db-concurrency";

export async function GET() {
  return withErrorHandling(async () => {
    const user = await getSessionUser();
    if (!user || !isAdminRole(user.role)) return apiError("Forbidden.", 403);

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(startOfDay.getTime() - 6 * 86_400_000);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Fifteen read queries per request, re-requested by the dashboard every 30 s.
    // They are submitted through `runWithDbConcurrency` so a small pool (the
    // production URL sets connection_limit=1) is never handed fifteen waiters at
    // once — a waiter that misses pool_timeout fails the whole request with P2024.
    const [
      totalOrders,
      newOrders,
      processingOrders,
      printingOrders,
      readyOrders,
      completedOrders,
      cancelledOrders,
      pendingPayments,
      underReviewPayments,
      revenueAgg,
      pagesToday,
      feedbackAgg,
      recentFeedback,
      statusGroups,
      colourSplit,
    ] = await runWithDbConcurrency([
      () => prisma.order.count(),
      () => prisma.order.count({ where: { createdAt: { gte: startOfDay } } }),
      () =>
        prisma.order.count({
          where: { status: { in: ["ORDER_RECEIVED", "ACCEPTED", "PROCESSING", "DOCUMENTS_RECEIVED", "PAYMENT_CONFIRMED"] } },
        }),
      () => prisma.order.count({ where: { status: "PRINTING" } }),
      () => prisma.order.count({ where: { status: { in: ["READY_FOR_PICKUP", "READY_FOR_COLLECTION"] } } }),
      () => prisma.order.count({ where: { status: { in: ["DELIVERED", "COMPLETED"] } } }),
      () => prisma.order.count({ where: { status: { in: ["CANCELLED", "REJECTED"] } } }),
      () => prisma.order.count({ where: { paymentStatus: "PAYMENT_PENDING" } }),
      () =>
        prisma.order.count({
          where: { paymentStatus: { in: ["PAYMENT_PROOF_SUBMITTED", "PAYMENT_UNDER_REVIEW"] } },
        }),
      () =>
        prisma.order.aggregate({
          _sum: { totalAmount: true },
          where: { paymentStatus: "PAYMENT_CONFIRMED" },
        }),
      () =>
        prisma.order.aggregate({
          _sum: { billablePages: true },
          where: { createdAt: { gte: startOfDay } },
        }),
      () => prisma.feedback.aggregate({ _avg: { rating: true }, _count: true }),
      () =>
        prisma.feedback.findMany({
          orderBy: { createdAt: "desc" },
          take: 5,
          include: { order: { select: { orderNumber: true } } },
        }),
      () => prisma.order.groupBy({ by: ["status"], _count: true }),
      () =>
        prisma.order.groupBy({
          by: ["colorMode"],
          _count: true,
          where: { status: { not: "CANCELLED" } },
        }),
    ]);

    return json({
      cards: {
        totalOrders,
        newOrders,
        processingOrders,
        printingOrders,
        readyOrders,
        completedOrders,
        cancelledOrders,
        pendingPayments,
        underReviewPayments,
        revenue: Number(revenueAgg._sum.totalAmount ?? 0),
        pagesToday: Number(pagesToday._sum.billablePages ?? 0),
        avgRating: feedbackAgg._avg.rating ? Number(feedbackAgg._avg.rating.toFixed(2)) : null,
        feedbackCount: feedbackAgg._count,
      },
      recentFeedback: recentFeedback.map((f) => ({
        id: f.id,
        rating: f.rating,
        comment: f.comment,
        orderNumber: f.order.orderNumber,
        createdAt: f.createdAt,
      })),
      statusDistribution: statusGroups.map((g) => ({ status: g.status, count: g._count })),
      colourSplit: colourSplit.map((g) => ({ colorMode: g.colorMode, count: g._count })),
    });
  });
}

export const dynamic = "force-dynamic";
