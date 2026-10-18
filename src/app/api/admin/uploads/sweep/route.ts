// POST /api/admin/uploads/sweep — the upload cleanup job.
//
// One bounded, re-runnable pass that:
//   * releases upload intents that expired before their object was verified (direct uploads);
//   * deletes unattached documents abandoned for longer than UNATTACHED_UPLOAD_TTL_HOURS;
//   * deletes order documents past the retention period (Settings → retention days).
//
// Callers: a Super Admin session (manual run), or a scheduler presenting
// `Authorization: Bearer <CRON_SECRET>` (see src/server/cron-auth.ts). The application runs no
// scheduler of its own, so one of these must call it on a schedule (DEPLOYMENT.md).
import { requireRole } from "@/server/auth";
import { apiError, enforceRateLimit, json, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { audit } from "@/server/audit";
import { runUploadSweep } from "@/server/document-lifecycle";
import { directUploadsSupported } from "@/server/direct-upload/capability";
import { isCronRequest } from "@/server/cron-auth";

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;

export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const scheduled = isCronRequest(req);
    const actor = scheduled ? null : await requireRole("SUPER_ADMIN");
    const limited = await enforceRateLimit(req, RATE_LIMITS.admin, "admin-uploads-sweep", actor?.id);
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

    const report = await runUploadSweep({ limit, intents: directUploadsSupported().enabled });
    await audit({
      actorId: actor?.id ?? null,
      actorRole: actor?.role ?? "SYSTEM",
      action: "UPLOAD_INTENTS_SWEEP",
      targetType: "SETTINGS",
      metadata: { ...report, trigger: scheduled ? "schedule" : "manual" },
    });
    return json(report);
  });
}

export const dynamic = "force-dynamic";
