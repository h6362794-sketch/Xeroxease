import { prisma } from "@/lib/prisma";
import { isAdminRole, getSessionUser } from "@/server/auth";
import { apiError, enforceRateLimit, json, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { ORDER_STATUS_VALUES } from "@/lib/order-status";

export async function GET(req: Request) {
  return withErrorHandling(async () => {
    const user = await getSessionUser();
    if (!user || !isAdminRole(user.role)) return apiError("Forbidden.", 403);

    const limited = await enforceRateLimit(req, RATE_LIMITS.admin, "admin-orders", user.id);
    if (limited) return limited;

    const url = new URL(req.url);
    const q = (url.searchParams.get("q")?.trim() || "").slice(0, 100);
    const rawStatus = url.searchParams.get("status") || "";
    const status = (ORDER_STATUS_VALUES as readonly string[]).includes(rawStatus) ? rawStatus : "";
    const paymentStatus = url.searchParams.get("paymentStatus") || "";
    // Fixed sort columns only: a client-supplied Prisma orderBy field is not an input.
    const sort = ["createdAt", "updatedAt", "totalAmount", "orderNumber"].includes(url.searchParams.get("sort") || "")
      ? (url.searchParams.get("sort") as string)
      : "createdAt";
    const dir = url.searchParams.get("dir") === "asc" ? "asc" : "desc";
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(100, Math.max(5, parseInt(url.searchParams.get("pageSize") || "15", 10) || 15));

    const where: Record<string, unknown> = {};
    if (status && status !== "ALL") where.status = status;
    if (paymentStatus && paymentStatus !== "ALL") where.paymentStatus = paymentStatus;
    if (q) {
      where.OR = [
        { orderNumber: { contains: q, mode: "insensitive" } },
        { user: { is: { OR: [{ name: { contains: q, mode: "insensitive" } }, { regNo: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }] } } },
      ];
    }

    const orderBy: Record<string, "asc" | "desc"> = { [sort]: dir };

    const [total, orders] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          user: { select: { id: true, name: true, email: true, regNo: true, phone: true, branch: true, section: true, year: true } },
          _count: { select: { files: true } },
        },
      }),
    ]);

    return json({
      orders: orders.map((o) => ({
        ...o,
        totalAmount: Number(o.totalAmount),
        pricePerPage: Number(o.pricePerPage),
        finishingFee: Number(o.finishingFee),
      })),
      total,
      page,
      pageSize,
    });
  });
}

export const dynamic = "force-dynamic";
