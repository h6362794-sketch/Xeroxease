import { prisma } from "@/lib/prisma";
import { requireRole } from "@/server/auth";
import { apiError, enforceRateLimit, json, parseBody, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { consumeCollectionToken, verifyCollectionToken } from "@/server/collection";
import { z } from "zod";

const schema = z.object({ token: z.string().min(10).max(120), consume: z.boolean().default(false) });

export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireRole("ADMIN", "SUPER_ADMIN");

    const limited = await enforceRateLimit(req, RATE_LIMITS.admin, "admin-collection");
    if (limited) return limited;

    const data = await parseBody(req, schema);

    const result = data.consume
      ? await consumeCollectionToken(data.token, { id: user.id, role: user.role })
      : await verifyCollectionToken(data.token);

    if (!result.ok) {
      // 409 = the code is well-formed but cannot be applied to the current state.
      return apiError(result.reason, 409, result.code);
    }

    const order = await prisma.order.findUnique({
      where: { id: result.orderId },
      include: { user: { select: { name: true, regNo: true } } },
    });
    if (!order) return apiError("Order not found.", 404);

    return json({
      ok: true,
      consumed: data.consume,
      order: {
        id: order.id,
        orderNumber: order.orderNumber,
        studentName: order.user.name,
        regNo: order.user.regNo,
        status: order.status,
      },
    });
  });
}

export const dynamic = "force-dynamic";
