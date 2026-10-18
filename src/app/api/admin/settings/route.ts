import { requireRole } from "@/server/auth";
import { json, parseBody, withErrorHandling } from "@/server/api-utils";
import { getSettings, updateSettings, type AppSettings } from "@/server/settings";
import { settingsPatchSchema as schema } from "@/lib/settings-policy";
import { audit } from "@/server/audit";


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
