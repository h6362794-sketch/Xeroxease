// POST /api/uploads/abort — give back an unused upload intent and delete its object.
//
// Without this, every abandoned browser tab leaves a PENDING document row (and
// possibly an uploaded-but-never-verified object) holding one of the ten per-order
// slots. Aborting is owner-only, only valid while the document is unverified, and is
// idempotent from the client's point of view.
import { z } from "zod";
import { requireUser } from "@/server/auth";
import { apiError, json, parseBody, withErrorHandling } from "@/server/api-utils";
import { UploadServiceError, abortUploadIntent } from "@/server/direct-upload/service";

const schema = z.object({ fileId: z.string().uuid() });

export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const body = await parseBody(req, schema);
    try {
      const result = await abortUploadIntent({ actor: { id: user.id, role: user.role }, fileId: body.fileId });
      return json(result);
    } catch (err) {
      if (err instanceof UploadServiceError) return apiError(err.message, err.status, err.code);
      throw err;
    }
  });
}

export const dynamic = "force-dynamic";
