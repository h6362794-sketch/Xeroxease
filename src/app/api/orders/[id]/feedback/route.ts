import { prisma } from "@/lib/prisma";
import { requireUser } from "@/server/auth";
import { apiError, enforceRateLimit, json, parseBody, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { feedbackSchema } from "@/server/validation";
import { audit } from "@/server/audit";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const limited = await enforceRateLimit(req, RATE_LIMITS.feedback, "feedback");
    if (limited) return limited;

    const { id } = params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return apiError("Invalid order id.", 400);

    const data = await parseBody(req, feedbackSchema);

    const order = await prisma.order.findUnique({
      where: { id },
      include: { feedback: true },
    });
    if (!order) return apiError("Order not found.", 404);

    // Ownership + completion checks
    if (order.userId !== user.id) return apiError("You can only rate your own orders.", 403);
    if (order.status !== "COMPLETED") {
      return apiError("Feedback is available after your order is completed.", 409);
    }
    if (order.feedback) return apiError("You have already rated this order.", 409);

    const fb = await prisma.feedback.create({
      data: {
        orderId: order.id,
        userId: user.id,
        rating: data.rating,
        comment: data.comment || null,
      },
      select: { id: true, rating: true },
    });

    await audit({
      actorId: user.id,
      actorRole: user.role,
      action: "FEEDBACK_SUBMITTED",
      targetType: "ORDER",
      targetId: order.id,
      metadata: { rating: data.rating },
    });

    return json({ ok: true, feedback: fb }, { status: 201 });
  });
}

export const dynamic = "force-dynamic";
