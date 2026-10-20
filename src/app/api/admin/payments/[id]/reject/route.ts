import { requireRole } from "@/server/auth";
import { apiError, enforceRateLimit, json, parseBody, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { paymentRejectionSchema } from "@/server/validation";
import { rejectPayment } from "@/server/payments";

/**
 * PATCH /api/admin/payments/:orderId/reject
 *
 * Rejects a submitted UPI reference with a mandatory reason. The student may
 * resubmit; the rejected reference stays in the payment history. No refund or
 * automatic reversal is performed.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withErrorHandling(async () => {
    const user = await requireRole("ADMIN", "SUPER_ADMIN");
    const limited = await enforceRateLimit(req, RATE_LIMITS.admin, "admin-payment-reject", user.id);
    if (limited) return limited;

    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return apiError("Invalid order id.", 400);

    const data = await parseBody(req, paymentRejectionSchema);
    await rejectPayment({
      orderId: id,
      actorId: user.id,
      actorRole: user.role,
      reason: data.reason,
    });

    return json({ ok: true, paymentStatus: "PAYMENT_REJECTED" });
  });
}

export const dynamic = "force-dynamic";
