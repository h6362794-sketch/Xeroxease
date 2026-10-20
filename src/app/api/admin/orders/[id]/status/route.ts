import { requireRole } from "@/server/auth";
import { apiError, enforceRateLimit, json, parseBody, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { adminStatusUpdateSchema } from "@/server/validation";
import { adminUpdateOrderStatus } from "@/server/orders";
import { ORDER_STATUS_VALUES, allowedNextStatuses } from "@/lib/order-status";

/**
 * PATCH /api/admin/orders/:id/status
 *
 * Admin-only. The service validates the role, the transition edge, the mandatory
 * rejection reason and the explicit delivery confirmation. The update is
 * conditional on the status that was read, so concurrent updates cannot both win.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withErrorHandling(async () => {
    const user = await requireRole("ADMIN", "SUPER_ADMIN");
    const limited = await enforceRateLimit(req, RATE_LIMITS.admin, "admin-order-status", user.id);
    if (limited) return limited;

    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return apiError("Invalid order id.", 400);

    const data = await parseBody(req, adminStatusUpdateSchema);
    if (!ORDER_STATUS_VALUES.includes(data.status as never)) {
      return apiError("Unknown status.", 400);
    }

    const result = await adminUpdateOrderStatus({
      orderId: id,
      toStatus: data.status,
      actorId: user.id,
      actorRole: user.role,
      note: data.note || undefined,
      confirm: data.confirm,
    });

    return json({
      ok: true,
      status: result.toStatus,
      previousStatus: result.fromStatus,
      allowedNextStatuses: allowedNextStatuses(result.toStatus),
    });
  });
}

export const dynamic = "force-dynamic";
