import { prisma } from "@/lib/prisma";
import { requireRole } from "@/server/auth";
import { apiError, json, withErrorHandling } from "@/server/api-utils";
import { audit } from "@/server/audit";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withErrorHandling(async () => {
    const actor = await requireRole("SUPER_ADMIN");
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return apiError("Invalid user id.", 400);
    if (id === actor.id) return apiError("You cannot disable your own account.", 400);

    const body = (await req.json().catch(() => ({}))) as { isActive?: boolean };
    if (typeof body.isActive !== "boolean") return apiError("Missing isActive flag.", 400);

    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) return apiError("User not found.", 404);

    await prisma.user.update({ where: { id }, data: { isActive: body.isActive } });
    if (!body.isActive) {
      // Force logout everywhere.
      await prisma.session.updateMany({ where: { userId: id }, data: { revokedAt: new Date() } });
    }

    await audit({
      actorId: actor.id,
      actorRole: actor.role,
      action: body.isActive ? "USER_ENABLED" : "USER_DISABLED",
      targetType: "USER",
      targetId: id,
      metadata: { role: target.role },
    });

    return json({ ok: true });
  });
}

export const dynamic = "force-dynamic";
