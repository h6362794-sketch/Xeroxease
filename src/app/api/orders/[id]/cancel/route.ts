import { requireUser } from "@/server/auth";
import { enforceRateLimit, json, parseBody, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { cancelSchema } from "@/server/validation";
import { cancelOrder } from "@/server/orders";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const limited = await enforceRateLimit(req, RATE_LIMITS.cancel, "cancel");
    if (limited) return limited;

    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      const err = new Error("Invalid order id.");
      (err as Error & { status?: number }).status = 400;
      throw err;
    }

    const data = await parseBody(req, cancelSchema);

    await cancelOrder({
      orderId: id,
      userId: user.id,
      reason: data.reason || undefined,
      actorRole: user.role,
    });

    return json({ ok: true });
  });
}

export const dynamic = "force-dynamic";
