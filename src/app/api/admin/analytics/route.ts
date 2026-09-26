import { prisma } from "@/lib/prisma";
import { getSessionUser, isAdminRole } from "@/server/auth";
import { apiError, json, withErrorHandling } from "@/server/api-utils";

export async function GET() {
  return withErrorHandling(async () => {
    const user = await getSessionUser();
    if (!user || !isAdminRole(user.role)) return apiError("Forbidden.", 403);

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(startOfDay.getTime() - 6 * 86_400_000);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

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
    ] = await Promise.all([
      prisma.order.count(),
      prisma.order.count({ where: { createdAt: { gte: startOfDay } } }),
      prisma.order.count({ where: { status: { in: ["PROCESSING", "DOCUMENTS_RECEIVED", "PAYMENT_CONFIRMED"] } } }),
      prisma.order.count({ where: { status: "PRINTING" } }),
      prisma.order.count({ where: { status: "READY_FOR_COLLECTION" } }),
      prisma.order.count({ where: { status: "COMPLETED" } }),
      prisma.order.count({ where: { status: "CANCELLED" } }),
      prisma.order.count({ where: { paymentStatus: "PAYMENT_PENDING" } }),
      prisma.order.count({ where: { paymentStatus: { in: ["PAYMENT_PROOF_SUBMITTED", "PAYMENT_UNDER_REVIEW"] } } }),
      prisma.order.aggregate({ _sum: { totalAmount: true }, where: { paymentStatus: "PAYMENT_CONFIRMED" } }),
      prisma.order.aggregate({ _sum: { billablePages: true }, where: { createdAt: { gte: startOfDay } } }),
      prisma.feedback.aggregate({ _avg: { rating: true }, _count: true }),
      prisma.feedback.findMany({
        orderBy: { createdAt: "desc" },
        take: 5,
        include: { order: { select: { orderNumber: true } } },
      }),
      prisma.order.groupBy({ by: ["status"], _count: true }),
      prisma.order.groupBy({ by: ["colorMode"], _count: true, where: { status: { not: "CANCELLED" } } }),
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
