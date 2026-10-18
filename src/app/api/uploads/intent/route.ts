// POST /api/uploads/intent — ask the server for permission to upload one document
// directly to private storage. No file bytes are accepted here, which is the whole
// point: the caller sends metadata, the server answers with a scoped, single-path,
// time-limited upload URL, and the browser PUTs the bytes straight to storage.
import { z } from "zod";
import { requireUser } from "@/server/auth";
import { apiError, enforceRateLimit, json, parseBody, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { UploadServiceError, createUploadIntent } from "@/server/direct-upload/service";
import { DeploymentCapabilityError } from "@/server/direct-upload/capability";

// Strict: an unknown field (including the removed `orderId`) is refused with a validation error,
// never silently dropped. Documents join an order only through createOrder, which prices them.
const schema = z
  .object({
  filename: z.string().min(1).max(255),
  /** Optional: browsers legitimately send application/octet-stream for blobs. */
  mimeType: z.string().max(128).optional().or(z.literal("")),
  /** Declared size. Never trusted — re-measured from storage at completion. */
  sizeBytes: z.union([z.number().int().nonnegative(), z.string().regex(/^\d{1,12}$/)]),
  })
  .strict();

export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const limited = await enforceRateLimit(req, RATE_LIMITS.uploadIntent, "upload-intent", user.id);
    if (limited) return limited;

    const body = await parseBody(req, schema);
    try {
      const intent = await createUploadIntent({
        actor: { id: user.id, role: user.role },
        filename: body.filename,
        declaredMime: body.mimeType ?? "",
        declaredSizeRaw: body.sizeBytes,
      });
      return json({ mode: "direct", ...intent }, { status: 201 });
    } catch (err) {
      // Domain rejections keep their status and message; anything else is a fault.
      if (err instanceof UploadServiceError) return apiError(err.message, err.status, err.code);
      if (err instanceof DeploymentCapabilityError) {
        // Not a fault, and not the caller's fault either: this deployment does not run
        // the protocol. Answer it explicitly, with a machine-readable code, so the
        // browser can fall back to the proxy route instead of seeing an opaque 500.
        return apiError(err.message, err.status, "DIRECT_UPLOAD_UNSUPPORTED");
      }
      throw err;
    }
  });
}

export const dynamic = "force-dynamic";
