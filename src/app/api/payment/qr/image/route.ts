import { requireUser } from "@/server/auth";
import { apiError, withErrorHandling } from "@/server/api-utils";
import { getSettings } from "@/server/settings";
import { fileExists, openStream } from "@/server/storage";

export const runtime = "nodejs";

export async function GET() {
  return withErrorHandling(async () => {
    await requireUser();

    const settings = await getSettings();
    if (!settings.paymentQrEnabled || !settings.paymentQrStorageKey) {
      return apiError("Payment QR is not configured.", 404);
    }
    if (!(await fileExists(settings.paymentQrStorageKey))) {
      return apiError("Payment QR file is missing.", 410);
    }

    const stream = await openStream(settings.paymentQrStorageKey);
    return new Response(stream as ReadableStream, {
      headers: {
        "Content-Type": settings.paymentQrMime || "image/png",
        "Cache-Control": "private, max-age=60",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}

export const dynamic = "force-dynamic";
