import { prisma } from "@/lib/prisma";
import { getSessionUser, isAdminRole, requireRole } from "@/server/auth";
import { apiError, json, withErrorHandling } from "@/server/api-utils";
import { audit } from "@/server/audit";

export async function GET(req: Request) {
  return withErrorHandling(async () => {
    const user = await getSessionUser();
    if (!user || !isAdminRole(user.role)) return apiError("Forbidden.", 403);

    const url = new URL(req.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(50, Math.max(5, parseInt(url.searchParams.get("pageSize") || "20", 10) || 20));

    const [total, items, agg] = await Promise.all([
      prisma.feedback.count(),
      prisma.feedback.findMany({
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { order: { select: { orderNumber: true } } },
      }),
      prisma.feedback.aggregate({ _avg: { rating: true }, _count: true }),
    ]);

    const dist = await prisma.feedback.groupBy({ by: ["rating"], _count: true });

    return json({
      feedback: items.map((f) => ({
        id: f.id,
        rating: f.rating,
        comment: f.comment,
        orderNumber: f.order.orderNumber,
        moderation: f.moderation,
        createdAt: f.createdAt,
      })),
      total,
      page,
      pageSize,
      avgRating: agg._avg.rating ? Number(agg._avg.rating.toFixed(2)) : null,
      count: agg._count,
      distribution: [5, 4, 3, 2, 1].map((r) => ({
        rating: r,
        count: dist.find((d) => d.rating === r)?._count ?? 0,
      })),
    });
  });
}

// Super Admin moderation: hide/show feedback
export async function PATCH(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireRole("SUPER_ADMIN");
    const body = (await req.json().catch(() => ({}))) as { id?: string; moderation?: string };
    if (!body.id || !["HIDDEN", "SHOWN"].includes(body.moderation ?? "")) {
      return apiError("Invalid moderation request.", 400);
    }
    await prisma.feedback.update({
      where: { id: body.id },
      data: { moderation: body.moderation },
    });
    await audit({
      actorId: user.id,
      actorRole: user.role,
      action: "FEEDBACK_MODERATED",
      targetType: "FEEDBACK",
      targetId: body.id,
      metadata: { moderation: body.moderation },
    });
    return json({ ok: true });
  });
}

export const dynamic = "force-dynamic";
