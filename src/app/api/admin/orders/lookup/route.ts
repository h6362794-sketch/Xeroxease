import { prisma } from "@/lib/prisma";
import { requireRole } from "@/server/auth";
import { apiError, enforceRateLimit, json, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { adminOrderWhere, parseAdminOrderSearch } from "@/lib/admin-search";

/**
 * GET /api/admin/orders/lookup
 *
 * Dedicated admin order search: order number/ID, student name/email/regNo,
 * status, payment status and a bounded date range. Server-side pagination and
 * admin-only authorization are enforced here; the response contains only the
 * summary needed by the lookup screen (full details require the per-order route).
 */
export async function GET(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireRole("ADMIN", "SUPER_ADMIN");
    const limited = await enforceRateLimit(req, RATE_LIMITS.adminSearch, "admin-order-search", user.id);
    if (limited) return limited;

    const parsed = parseAdminOrderSearch(new URL(req.url).searchParams);
    if (!parsed.ok) return apiError(parsed.message, 422, "INVALID_SEARCH");

    const { page, pageSize } = parsed.value;
    const where = adminOrderWhere(parsed.value);

    const [total, orders] = await Promise.all([
      prisma.order.count({ where: where as never }),
      prisma.order.findMany({
        where: where as never,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          paymentStatus: true,
          paymentMethod: true,
          totalAmount: true,
          totalPages: true,
          copies: true,
          colorMode: true,
          paperSize: true,
          createdAt: true,
          updatedAt: true,
          user: { select: { name: true, email: true, regNo: true, phone: true } },
          _count: { select: { files: true } },
        },
      }),
    ]);

    return json({
      orders: orders.map((o) => ({ ...o, totalAmount: Number(o.totalAmount) })),
      total,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
    });
  });
}

export const dynamic = "force-dynamic";
