import { prisma } from "@/lib/prisma";
import { requireUser, isAdminRole } from "@/server/auth";
import { apiError, withErrorHandling } from "@/server/api-utils";
import { readBuffer, fileExists } from "@/server/storage";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { id } = params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return apiError("Invalid file id.", 400);

    const file = await prisma.uploadedFile.findUnique({ where: { id } });
    if (!file) return apiError("File not found.", 404);

    // Ownership or admin check (IDOR protection)
    if (file.uploaderId !== user.id && !isAdminRole(user.role)) {
      return apiError("You do not have access to this file.", 403);
    }

    if (!(await fileExists(file.storageKey))) {
      return apiError("File not found on storage.", 404);
    }

    const data = await readBuffer(file.storageKey);

    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": file.mimeType || "application/octet-stream",
        "Content-Disposition": `inline; filename="${encodeURIComponent(file.originalName)}"`,
        "Cache-Control": "private, no-store",
      },
    });
  });
}

export const dynamic = "force-dynamic";
