import { prisma } from "@/lib/prisma";
import { json, withErrorHandling, enforceRateLimit } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";

export async function GET(req: Request) {
  return withErrorHandling(async () => {
    const limited = enforceRateLimit(req, RATE_LIMITS.publicApi, "pricing");
    if (limited) return limited;

    const rows = await prisma.pricingConfig.findMany({ where: { isActive: true }, orderBy: [{ category: "asc" }, { label: "asc" }] });
    return json({
      pricing: rows.map((r) => ({
        key: r.key,
        label: r.label,
        category: r.category,
        unit: r.unit,
        unitPrice: Number(r.unitPrice),
      })),
    });
  });
}

export const dynamic = "force-dynamic";
