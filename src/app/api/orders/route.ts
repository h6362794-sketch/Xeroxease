import { prisma } from "@/lib/prisma";
import { requireUser } from "@/server/auth";
import { apiError, enforceRateLimit, json, parseBody, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { orderCreateSchema } from "@/server/validation";
import { createOrder } from "@/server/orders";

export async function GET(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const url = new URL(req.url);
    const q = url.searchParams.get("q")?.trim() || "";
    const status = url.searchParams.get("status") || "";
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(50, Math.max(5, parseInt(url.searchParams.get("pageSize") || "10", 10) || 10));

    const where = {
      userId: user.id,
      ...(status && status !== "ALL" ? { status: status as never } : {}),
      ...(q ? { orderNumber: { contains: q, mode: "insensitive" as const } } : {}),
    };

    const [total, orders] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          orderNumber: true,
          status: true,
          paymentStatus: true,
          totalAmount: true,
          totalPages: true,
          copies: true,
          colorMode: true,
          paperSize: true,
          createdAt: true,
          feedback: { select: { id: true, rating: true } },
        },
      }),
    ]);

    return json({
      orders: orders.map((o) => ({ ...o, totalAmount: Number(o.totalAmount) })),
      total,
      page,
      pageSize,
    });
  });
}

export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    if (user.role !== "STUDENT") return apiError("Only students can create orders.", 403);

    const limited = await enforceRateLimit(req, RATE_LIMITS.orderCreate, "order-create");
    if (limited) return limited;

    // Read and validate the body exactly once, `fileIds` included.
    //
    // This used to be two reads: `parseBody` consumed the stream via `req.json()`,
    // then `req.clone().json()` fetched `fileIds`. A Request whose body has been
    // read is "disturbed", and cloning it throws `TypeError: unusable`
    // *synchronously* — the `.catch(() => [])` chained onto the clone never saw it,
    // so every POST /api/orders died with a 500 before `createOrder` was reached.
    // Keeping both fields in one schema also means `fileIds` is validated instead
    // of being coerced out of unvalidated JSON.
    const data = await parseBody(req, orderCreateSchema);

    const order = await createOrder({
      userId: user.id,
      fileIds: data.fileIds,
      paperSize: data.paperSize,
      colorMode: data.colorMode,
      sides: data.sides,
      copies: data.copies,
      pageSelection: data.pageSelection,
      customPages: data.customPages,
      finishing: data.finishing ?? [],
    });

    return json(
      {
        order: {
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          paymentStatus: order.paymentStatus,
          totalAmount: Number(order.totalAmount),
        },
      },
      { status: 201 }
    );
  });
}

export const dynamic = "force-dynamic";
