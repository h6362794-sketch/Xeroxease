import { requireRole } from "@/server/auth";
import { apiError, parseBody, withErrorHandling } from "@/server/api-utils";
import { adminStatusUpdateSchema } from "@/server/validation";
import { adminUpdateOrderStatus } from "@/server/orders";
import { PUBLIC_STATUSES } from "@/lib/constants";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  return withErrorHandling(async () => {
    const user = await requireRole("ADMIN", "SUPER_ADMIN");
    const { id } = params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return apiError("Invalid order id.", 400);

    const data = await parseBody(req, adminStatusUpdateSchema);
    if (!(PUBLIC_STATUSES as readonly string[]).includes(data.status)) {
      return apiError("Unknown status.", 400);
    }

    await adminUpdateOrderStatus({
      orderId: id,
      toStatus: data.status,
      actorId: user.id,
      actorRole: user.role,
      note: data.note || undefined,
    });

    return Response.json({ ok: true });
  });
}

export const dynamic = "force-dynamic";
