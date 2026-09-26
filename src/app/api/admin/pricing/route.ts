import { prisma } from "@/lib/prisma";
import { requireRole } from "@/server/auth";
import { apiError, json, parseBody, withErrorHandling } from "@/server/api-utils";
import { pricingUpdateSchema } from "@/server/validation";
import { audit } from "@/server/audit";

export async function GET() {
  return withErrorHandling(async () => {
    await requireRole("ADMIN", "SUPER_ADMIN");
    const rows = await prisma.pricingConfig.findMany({ orderBy: [{ category: "asc" }, { label: "asc" }] });
    return json({
      pricing: rows.map((r) => ({ ...r, unitPrice: Number(r.unitPrice) })),
    });
  });
}

export async function PATCH(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireRole("SUPER_ADMIN");

    const data = await parseBody(req, pricingUpdateSchema);
    const before = await prisma.pricingConfig.findMany();

    for (const item of data.items) {
      await prisma.pricingConfig.update({
        where: { key: item.key },
        data: {
          unitPrice: item.unitPrice,
          isActive: item.isActive ?? true,
          updatedBy: user.id,
        },
      });
    }

    await audit({
      actorId: user.id,
      actorRole: user.role,
      action: "PRICING_UPDATED",
      targetType: "PRICING",
      metadata: {
        changes: data.items.map((i) => {
          const prev = before.find((b) => b.key === i.key);
          return { key: i.key, from: prev ? Number(prev.unitPrice) : null, to: i.unitPrice };
        }),
      },
    });

    return json({ ok: true });
  });
}

export const dynamic = "force-dynamic";
