import { requireUser } from "@/server/auth";
import { apiError, enforceRateLimit, json, parseBody, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { paymentSubmitSchema } from "@/server/validation";
import { submitUpiReference } from "@/server/payments";

/**
 * Submit a UPI transaction reference.
 *
 * Payment choices only exist after an administrator accepts the order. Submitting
 * a reference moves the payment to UNDER_REVIEW — it never marks the order paid.
 * Ownership and every payment invariant are re-checked in the service.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const limited = await enforceRateLimit(req, RATE_LIMITS.paymentSubmit, "pay-submit", user.id);
    if (limited) return limited;

    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return apiError("Invalid order id.", 400);

    const data = await parseBody(req, paymentSubmitSchema);
    await submitUpiReference({ orderId: id, userId: user.id, reference: data.reference });

    return json({
      ok: true,
      message: "Reference submitted. The print desk will verify it — your payment is not confirmed yet.",
      paymentStatus: "PAYMENT_UNDER_REVIEW",
    });
  });
}

export const dynamic = "force-dynamic";
