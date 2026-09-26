import { prisma } from "@/lib/prisma";
import { requireRole, isAdminRole, getSessionUser } from "@/server/auth";
import { apiError, json, withErrorHandling } from "@/server/api-utils";

export async function GET(req: Request) {
  return withErrorHandling(async () => {
    const user = await getSessionUser();
    if (!user || !isAdminRole(user.role)) return apiError("Forbidden.", 403);

    const url = new URL(req.url);
    const q = url.searchParams.get("q")?.trim() || "";
    const status = url.searchParams.get("status") || "";
    const paymentStatus = url.searchParams.get("paymentStatus") || "";
    const sort = url.searchParams.get("sort") || "createdAt";
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
