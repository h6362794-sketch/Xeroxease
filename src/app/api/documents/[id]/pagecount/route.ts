import { requireUser } from "@/server/auth";
import { apiError, enforceRateLimit, json, parseBody, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { pageCountConfirmSchema } from "@/server/validation";
import { confirmFilePageCount } from "@/server/documents";

/**
 * Lets the owner of a document confirm its page count when automatic analysis was
 * inconclusive. Without this, NEEDS_REVIEW documents (legacy .doc, metadata-less
 * .docx) could never be ordered without administrator intervention.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withErrorHandling(async () => {
    const user = await requireUser();

    const limited = await enforceRateLimit(req, RATE_LIMITS.analyze, "doc-pagecount");
    if (limited) return limited;

    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return apiError("Invalid document id.", 400);

    const data = await parseBody(req, pageCountConfirmSchema);
    const file = await confirmFilePageCount({ fileId: id, userId: user.id, pageCount: data.pageCount });

    return json({ ok: true, fileId: file.id, pageCount: file.pageCount, analysisStatus: "COMPLETED" });
  });
}

export const dynamic = "force-dynamic";
