// POST /api/admin/collection/override — complete a collected order whose collection code cannot be
// presented. Super Admin only. The rules (role, reason, identity confirmation, typed order number,
// unused code, audit in the same transaction) are enforced in overrideLostCollectionCode in
// src/server/collection.ts.
import { z } from "zod";
import { requireRole } from "@/server/auth";
import { apiError, enforceRateLimit, json, parseBody, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import {
  CollectionOverrideError,
  OVERRIDE_REASON_MAX,
  OVERRIDE_REASON_MIN,
  overrideLostCollectionCode,
} from "@/server/collection";

const schema = z.object({
  orderNumber: z.string().trim().min(1).max(40),
  confirmOrderNumber: z.string().trim().min(1).max(40),
  reason: z.string().trim().min(OVERRIDE_REASON_MIN).max(OVERRIDE_REASON_MAX),
  identityChecked: z.literal(true),
});

export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireRole("SUPER_ADMIN");
    const limited = await enforceRateLimit(req, RATE_LIMITS.admin, "admin-collection-override", user.id);
    if (limited) return limited;

    const data = await parseBody(req, schema);
    try {
      const result = await overrideLostCollectionCode({
        actor: { id: user.id, role: user.role },
        orderNumber: data.orderNumber,
        confirmOrderNumber: data.confirmOrderNumber,
        reason: data.reason,
        identityChecked: data.identityChecked,
      });
      return json({ ok: true, orderNumber: result.orderNumber });
    } catch (err) {
      if (err instanceof CollectionOverrideError) return apiError(err.message, err.status);
      throw err;
    }
  });
}

export const dynamic = "force-dynamic";
