// POST /api/admin/uploads/sweep — release upload intents that expired before their
// object was ever verified (SUPER_ADMIN only).
//
// This application deliberately has no cron/worker, so abandoned uploads need a
// trigger an operator controls. The sweep is bounded (default 50 rows) and
// re-runnable; it deletes only PENDING rows plus their objects, never anything that an
// order can reference, because `createOrder` attaches only COMPLETED documents.
import { requireRole } from "@/server/auth";
import { apiError, enforceRateLimit, json, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { audit } from "@/server/audit";
import { releaseExpiredIntents } from "@/server/direct-upload/service";
import { directUploadsSupported } from "@/server/direct-upload/capability";

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;

export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const actor = await requireRole("SUPER_ADMIN");
    const limited = await enforceRateLimit(req, RATE_LIMITS.admin, "admin-uploads-sweep", actor.id);
    if (limited) return limited;

    const url = new URL(req.url);
    const raw = url.searchParams.get("limit");
    let limit = DEFAULT_LIMIT;
    if (raw !== null) {
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
        return apiError(`limit must be a whole number between 1 and ${MAX_LIMIT}.`, 400);
      }
      limit = parsed;
    }

    if (!directUploadsSupported().enabled) {
      // Nothing can expire on a backend that never issues intents.
      return json({ released: 0, attempted: 0, skipped: "DIRECT_UPLOADS_UNAVAILABLE" });
    }

    const report = await releaseExpiredIntents(limit);
    await audit({
      actorId: actor.id,
      actorRole: actor.role,
      action: "UPLOAD_INTENTS_SWEEP",
      targetType: "SETTINGS",
      metadata: { ...report },
    });
    return json(report);
  });
}

export const dynamic = "force-dynamic";
