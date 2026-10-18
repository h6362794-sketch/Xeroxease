// DELETE /api/uploads/:id — a student removes a document they uploaded but have not ordered.
//
// Only the uploader's own unattached document can be removed. A document already on an order
// is never deleted here (the order needs it); the 404 for it is deliberately the same as for a
// document that does not exist, so the route is not an existence oracle for other users.
import { requireUser } from "@/server/auth";
import { apiError, enforceRateLimit, json, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { purgeUnattachedUpload } from "@/server/document-lifecycle";
import { audit } from "@/server/audit";

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const limited = await enforceRateLimit(req, RATE_LIMITS.upload, "upload-delete", user.id);
    if (limited) return limited;

    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return apiError("Invalid file id.", 400);

    const outcome = await purgeUnattachedUpload(id, user.id);
    if (outcome === "not_found") {
      return apiError("Document not found, or it is already attached to an order.", 404);
    }
    if (outcome === "failed") {
      return apiError("We could not remove that document right now. Please try again.", 503);
    }
    await audit({
      actorId: user.id,
      actorRole: user.role,
      action: "UPLOAD_REMOVED",
      targetType: "FILE",
      targetId: id,
      metadata: { by: "student" },
    });
    return json({ ok: true });
  });
}

export const dynamic = "force-dynamic";
