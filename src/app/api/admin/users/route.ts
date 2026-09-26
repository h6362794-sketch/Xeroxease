import { prisma } from "@/lib/prisma";
import { getSessionUser, isAdminRole, hashPassword, requireRole } from "@/server/auth";
import { apiError, json, parseBody, withErrorHandling } from "@/server/api-utils";
import { createUserSchema } from "@/server/validation";
import { audit } from "@/server/audit";

export async function GET(req: Request) {
  return withErrorHandling(async () => {
    const user = await getSessionUser();
    if (!user || !isAdminRole(user.role)) return apiError("Forbidden.", 403);

    const url = new URL(req.url);
    const q = url.searchParams.get("q")?.trim() || "";
    const role = url.searchParams.get("role") || "";
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(50, Math.max(5, parseInt(url.searchParams.get("pageSize") || "20", 10) || 20));

    const where: Record<string, unknown> = {};
    if (role && role !== "ALL") where.role = role;
    if (q) {
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { emailNorm: { contains: q, mode: "insensitive" } },
        { regNo: { contains: q, mode: "insensitive" } },
        { phone: { contains: q } },
      ];
    }

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          regNo: true,
          branch: true,
          section: true,
          year: true,
          role: true,
          isActive: true,
          createdAt: true,
          lastLoginAt: true,
        },
      }),
    ]);

    return json({ users, total, page, pageSize });
  });
}

// Super Admin: provision admin accounts (no public admin signup exists).
export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const actor = await requireRole("SUPER_ADMIN");
    const data = await parseBody(req, createUserSchema);

    const dup = await prisma.user.findFirst({
      where: { OR: [{ emailNorm: data.email }, ...(data.phone ? [{ phone: data.phone }] : [])] },
      select: { emailNorm: true },
    });
    if (dup) return apiError("An account with this email already exists.", 409);

    const { hash } = await hashPassword(data.password);
    const created = await prisma.user.create({
      data: {
        name: data.name,
        email: data.email,
        emailNorm: data.email,
        phone: data.phone || null,
        passwordHash: hash,
        role: data.role,
        emailVerified: true,
      },
      select: { id: true, role: true },
    });

    await audit({
      actorId: actor.id,
      actorRole: actor.role,
      action: "ADMIN_CREATED",
      targetType: "USER",
      targetId: created.id,
      metadata: { role: data.role },
    });

    return json({ ok: true, id: created.id }, { status: 201 });
  });
}

export const dynamic = "force-dynamic";
