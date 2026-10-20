import { prisma } from "@/lib/prisma";
import { requireRole } from "@/server/auth";
import { apiError, enforceRateLimit, json, parseBody, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { pricingUpdateSchema } from "@/server/validation";

/**
 * GET /api/admin/pricing
 *
 * Admin-only read of the live price list plus the most recent price-change audit
 * records (previous value, new value, administrator, timestamp). The active table
 * is read directly from the database on every request, so no cache can go stale.
 */
export async function GET(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireRole("ADMIN", "SUPER_ADMIN");
    const limited = await enforceRateLimit(req, RATE_LIMITS.admin, "admin-pricing", user.id);
    if (limited) return limited;

    const [rows, history] = await Promise.all([
      prisma.pricingConfig.findMany({ orderBy: [{ category: "asc" }, { label: "asc" }] }),
      prisma.auditLog.findMany({
        where: { action: "PRICING_UPDATED" },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { id: true, actorId: true, actorRole: true, metadata: true, createdAt: true },
      }),
    ]);

    return json({
      pricing: rows.map((r) => ({ ...r, unitPrice: Number(r.unitPrice) })),
      history,
    });
  });
}

/**
 * PATCH /api/admin/pricing
 *
 * SUPER_ADMIN only (unchanged from the existing least-privilege rule). All
 * updates run in one transaction after verifying every key exists; the audit
 * entry records the exact previous -> new value per key. Existing orders are
 * untouched: their amount and pricing snapshot were fixed at order creation.
 */
export async function PATCH(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireRole("SUPER_ADMIN");
    const limited = await enforceRateLimit(req, RATE_LIMITS.admin, "admin-pricing-write", user.id);
    if (limited) return limited;

    const data = await parseBody(req, pricingUpdateSchema);

    const before = await prisma.pricingConfig.findMany();
    const byKey = new Map(before.map((row) => [row.key, row]));

    const missing = data.items.filter((i) => !byKey.has(i.key)).map((i) => i.key);
    if (missing.length > 0) {
      return apiError(`Unknown pricing key(s): ${missing.slice(0, 5).join(", ")}.`, 422, "UNKNOWN_PRICE_KEY");
    }

    const changes = data.items
      .map((item) => {
        const prev = byKey.get(item.key)!;
        return {
          key: item.key,
          from: Number(prev.unitPrice),
          to: item.unitPrice,
          activeFrom: prev.isActive,
          activeTo: item.isActive ?? prev.isActive,
          changed: Number(prev.unitPrice) !== item.unitPrice || (item.isActive ?? prev.isActive) !== prev.isActive,
        };
      })
      .filter((c) => c.changed);

    if (changes.length === 0) {
      return json({ ok: true, updated: 0, changes: [] });
    }

    // Conditional write + audit in ONE transaction.
    //
    // The update is predicated on the previous price, so if another administrator
    // changed the same row after we read it, `count` is 0 and the whole request
    // rolls back with a conflict instead of silently overwriting their change.
    // The audit row is written in the same transaction, so a price can never be
    // persisted without its previous -> new record (and vice versa).
    await prisma.$transaction(async (tx) => {
      for (const change of changes) {
        const prev = byKey.get(change.key)!;
        const updated = await tx.pricingConfig.updateMany({
          where: { key: change.key, unitPrice: prev.unitPrice, isActive: prev.isActive },
          data: {
            unitPrice: change.to,
            isActive: change.activeTo,
            updatedBy: user.id,
          },
        });
        if (updated.count !== 1) {
          throw Object.assign(
            new Error("Prices were changed by someone else. Reload and try again."),
            { status: 409 }
          );
        }
      }

      await tx.auditLog.create({
        data: {
          actorId: user.id,
          actorRole: user.role,
          action: "PRICING_UPDATED",
          targetType: "PRICING",
          metadata: {
            changes: changes.map((c) => ({
              key: c.key,
              from: c.from,
              to: c.to,
              activeFrom: c.activeFrom,
              activeTo: c.activeTo,
            })),
          } as never,
        },
      });
    });

    return json({ ok: true, updated: changes.length, changes });
  });
}

export const dynamic = "force-dynamic";
