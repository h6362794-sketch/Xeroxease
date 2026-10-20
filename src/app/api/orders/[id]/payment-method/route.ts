import { requireUser } from "@/server/auth";
import { apiError, enforceRateLimit, json, parseBody, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { paymentMethodSchema } from "@/server/validation";
import { selectPaymentMethod } from "@/server/payments";

/**
 * POST /api/orders/:id/payment-method
 *
 * Records the student's payment preference after acceptance. Selecting Cash
 * never marks the order paid; the desk records receipt separately.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const limited = await enforceRateLimit(req, RATE_LIMITS.paymentMethod, "pay-method", user.id);
    if (limited) return limited;

    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return apiError("Invalid order id.", 400);

    const data = await parseBody(req, paymentMethodSchema);
    const result = await selectPaymentMethod({ orderId: id, userId: user.id, method: data.method });

    return json({ ok: true, paymentMethod: result.method });
  });
}

export const dynamic = "force-dynamic";
