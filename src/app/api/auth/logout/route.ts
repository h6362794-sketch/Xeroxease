import { destroySession, getSessionUser } from "@/server/auth";
import { json, withErrorHandling } from "@/server/api-utils";
import { audit } from "@/server/audit";

export async function POST() {
  return withErrorHandling(async () => {
    const user = await getSessionUser();
    await destroySession();
    if (user) {
      await audit({ actorId: user.id, actorRole: user.role, action: "LOGOUT", targetType: "USER", targetId: user.id });
    }
    return json({ ok: true });
  });
}

export const dynamic = "force-dynamic";
