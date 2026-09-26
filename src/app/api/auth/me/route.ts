import { getSessionUser } from "@/server/auth";
import { json, withErrorHandling } from "@/server/api-utils";

export async function GET() {
  return withErrorHandling(async () => {
    const user = await getSessionUser();
    if (!user) return json({ user: null });
    return json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  });
}

export const dynamic = "force-dynamic";
