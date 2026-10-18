// Scheduler credential for the upload cleanup (POST /api/admin/uploads/sweep).
//
// A scheduler cannot hold a Super Admin session, so the sweep also accepts
//   Authorization: Bearer <CRON_SECRET>
// plus a deployment-target header:
//   X-Deploy-Target: staging | production
// The request is honoured only when that header equals this deployment's DEPLOY_TARGET. A
// staging scheduler that is mis-pointed at production is therefore refused by production, even
// though the bearer secret is different on each side anyway. Vercel's own cron runs only on
// production deployments (vercel.com/docs/cron-jobs), so Preview needs an external scheduler.
//
// CRON_SECRET must be at least MIN_CRON_SECRET_LENGTH characters. When it is unset or too short,
// the scheduled path is off and only a Super Admin session can run the sweep. The comparison is
// constant-time.
import { timingSafeEqual } from "crypto";
import { env } from "./env";

export const MIN_CRON_SECRET_LENGTH = 32;
export const SCHEDULER_TARGET_HEADER = "x-deploy-target";

/**
 * - "none": not a scheduler request (no valid bearer). Fall through to the session check.
 * - "refused": a valid bearer, but for a different deployment target (or none is configured).
 * - "scheduler": a valid bearer for this deployment.
 */
export type SchedulerState = "none" | "refused" | "scheduler";

function bearerMatches(req: Request): boolean {
  const secret = env.CRON_SECRET ?? "";
  if (secret.length < MIN_CRON_SECRET_LENGTH) return false;
  const match = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
  if (!match) return false;
  const given = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(secret, "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function schedulerState(req: Request): SchedulerState {
  if (!bearerMatches(req)) return "none";
  const here = env.DEPLOY_TARGET ?? "";
  const asked = (req.headers.get(SCHEDULER_TARGET_HEADER) ?? "").trim().toLowerCase();
  if (here === "" || asked !== here) return "refused";
  return "scheduler";
}

/** Kept for callers that only need the yes/no answer. Treats a refused target as "not a scheduler". */
export function isCronRequest(req: Request): boolean {
  return schedulerState(req) === "scheduler";
}
