import { prisma } from "@/lib/prisma";
import { requireUser } from "@/server/auth";
import { apiError, json, withErrorHandling } from "@/server/api-utils";
import { getSettings } from "@/server/settings";

export async function GET() {
  return withErrorHandling(async () => {
    const user = await requireUser();

    const settings = await getSettings();
    if (!settings.paymentQrEnabled || !settings.paymentQrStorageKey) {
      return json({
        enabled: false,
        instructions: settings.paymentInstructions,
        accountDisplay: settings.paymentAccountDisplay,
      });
    }

    const qrUrl = `/api/payment/qr/image?v=${encodeURIComponent(settings.paymentQrFileName ?? "qr")}`;

    return json({
      enabled: true,
      qrUrl,
      instructions: settings.paymentInstructions,
      accountDisplay: settings.paymentAccountDisplay,
    });
  });
}

export const dynamic = "force-dynamic";
