// Scheduler credential for the upload cleanup (POST /api/admin/uploads/sweep).
//
// A platform cron job cannot hold a Super Admin session, so the sweep also accepts
// `Authorization: Bearer <CRON_SECRET>`. The secret is optional: when it is unset, or shorter
// than MIN_CRON_SECRET_LENGTH, the scheduled path is disabled and only a Super Admin can run the
// sweep. The comparison is constant-time.
import { timingSafeEqual } from "crypto";
import { env } from "./env";

export const MIN_CRON_SECRET_LENGTH = 32;

export function isCronRequest(req: Request): boolean {
  const secret = env.CRON_SECRET ?? "";
  if (secret.length < MIN_CRON_SECRET_LENGTH) return false;
  const match = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
  if (!match) return false;
  const given = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(secret, "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
