import { requireRole } from "@/server/auth";
import { json, parseBody, withErrorHandling } from "@/server/api-utils";
import { getSettings, updateSettings, type AppSettings } from "@/server/settings";
import { z } from "zod";
import { audit } from "@/server/audit";

const schema = z.object({
  paymentInstructions: z.string().max(1000).optional(),
  paymentAccountDisplay: z.string().max(120).optional(),
  retentionDays: z.coerce.number().int().min(1).max(3650).optional(),
  queuePagesPerHour: z.coerce.number().int().min(50).max(100000).optional(),
  cancellationAllowedStatuses: z.array(z.string().max(40)).max(12).optional(),
});

export async function GET() {
  return withErrorHandling(async () => {
    await requireRole("SUPER_ADMIN");
    return json({ settings: await getSettings() });
  });
}

export async function PATCH(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireRole("SUPER_ADMIN");
    const data = await parseBody(req, schema);

    const settings = await updateSettings(data as Partial<AppSettings>, user.id);
    await audit({
      actorId: user.id,
      actorRole: user.role,
      action: "SETTINGS_UPDATED",
      targetType: "SETTINGS",
      metadata: { keys: Object.keys(data) },
    });

    return json({ settings });
  });
}

export const dynamic = "force-dynamic";
