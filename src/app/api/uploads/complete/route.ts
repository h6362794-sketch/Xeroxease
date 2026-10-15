// POST /api/uploads/complete — claim that a direct upload has finished.
//
// The request body carries a document id and the completion token: **no** size, type
// or filename claims are accepted from the client. Everything the response reports is
// re-read from storage (measured size, first bytes) and cross-checked against the
// intent the server minted. A forged or replayed token fails; an object that is
// missing, oversized or not a real document fails and is deleted.
import { z } from "zod";
import { requireUser } from "@/server/auth";
import { apiError, enforceRateLimit, json, parseBody, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { UploadServiceError, completeUploadIntent } from "@/server/direct-upload/service";
import { DeploymentCapabilityError } from "@/server/direct-upload/capability";

const schema = z.object({
  fileId: z.string().uuid(),
  token: z.string().min(20).max(2048),
});

export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const limited = await enforceRateLimit(req, RATE_LIMITS.uploadComplete, "upload-complete", user.id);
    if (limited) return limited;

    const body = await parseBody(req, schema);
    try {
      const file = await completeUploadIntent({
        actor: { id: user.id, role: user.role },
        fileId: body.fileId,
        token: body.token,
      });
      return json({ file });
    } catch (err) {
      if (err instanceof UploadServiceError) return apiError(err.message, err.status, err.code);
      // See the intent route: a capability answer is a documented outcome, so it keeps
      // its own status and code instead of being masked as a generic 500.
      if (err instanceof DeploymentCapabilityError) {
        return apiError(err.message, err.status, "DIRECT_UPLOAD_UNSUPPORTED");
      }
      throw err;
    }
  });
}

export const dynamic = "force-dynamic";
