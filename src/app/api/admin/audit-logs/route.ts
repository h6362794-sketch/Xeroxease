import { prisma } from "@/lib/prisma";
import { requireRole } from "@/server/auth";
import { json, withErrorHandling } from "@/server/api-utils";

export async function GET(req: Request) {
  return withErrorHandling(async () => {
    await requireRole("SUPER_ADMIN");

    const url = new URL(req.url);
    const action = url.searchParams.get("action") || "";
    const q = url.searchParams.get("q")?.trim() || "";
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(100, Math.max(10, parseInt(url.searchParams.get("pageSize") || "30", 10) || 30));

    const where: Record<string, unknown> = {};
    if (action && action !== "ALL") where.action = action;
    if (q) where.OR = [{ targetType: { contains: q, mode: "insensitive" } }, { targetId: q }];

    const [total, logs] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { actor: { select: { name: true, email: true, role: true } } },
      }),
    ]);

    const actions = await prisma.auditLog.findMany({
      distinct: ["action"],
      select: { action: true },
      take: 200,
    });

    return json({
      logs: logs.map((l) => ({
        id: l.id,
        action: l.action,
        actor: l.actor ? { name: l.actor.name, role: l.actor.role } : null,
        targetType: l.targetType,
        targetId: l.targetId,
        metadata: l.metadata,
        ip: l.ip,
        createdAt: l.createdAt,
      })),
      actions: actions.map((a) => a.action),
      total,
      page,
      pageSize,
    });
  });
}

export const dynamic = "force-dynamic";
