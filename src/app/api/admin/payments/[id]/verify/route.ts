import { requireRole } from "@/server/auth";
import { apiError, enforceRateLimit, json, parseBody, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { paymentDecisionSchema } from "@/server/validation";
import { verifyPayment } from "@/server/payments";

/**
 * PATCH /api/admin/payments/:orderId/verify
 *
 * Marks money as received after a human check. Works for cash-at-pickup and for a
 * manually verified UPI reference. The printing lifecycle is deliberately NOT
 * advanced here, and students can never reach this route.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withErrorHandling(async () => {
    const user = await requireRole("ADMIN", "SUPER_ADMIN");
    const limited = await enforceRateLimit(req, RATE_LIMITS.admin, "admin-payment-verify", user.id);
    if (limited) return limited;

    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return apiError("Invalid order id.", 400);

    const data = await parseBody(req, paymentDecisionSchema);
    if (data.confirm !== true) {
      return apiError(
        "Confirm that you have checked the payment before marking it received.",
        422,
        "CONFIRMATION_REQUIRED"
      );
    }
    await verifyPayment({
      orderId: id,
      actorId: user.id,
      actorRole: user.role,
      note: data.note || undefined,
    });

    return json({ ok: true, paymentStatus: "PAYMENT_CONFIRMED" });
  });
}

export const dynamic = "force-dynamic";
