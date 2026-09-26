import { prisma } from "@/lib/prisma";
import { requireUser } from "@/server/auth";
import { json, withErrorHandling } from "@/server/api-utils";
import { z } from "zod";
import { parseBody } from "@/server/api-utils";

export async function GET(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const url = new URL(req.url);
    const take = Math.min(50, Math.max(1, parseInt(url.searchParams.get("take") || "20", 10) || 20));

    const [items, unread] = await Promise.all([
      prisma.notification.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take,
      }),
      prisma.notification.count({ where: { userId: user.id, isRead: false } }),
    ]);

    return json({ notifications: items, unread });
  });
}

const markSchema = z.object({ id: z.string().uuid().optional(), all: z.boolean().optional() });

export async function PATCH(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const data = await parseBody(req, markSchema);

    if (data.all) {
      await prisma.notification.updateMany({
        where: { userId: user.id, isRead: false },
        data: { isRead: true },
      });
      return json({ ok: true });
    }
    if (data.id) {
      await prisma.notification.updateMany({
        where: { id: data.id, userId: user.id },
        data: { isRead: true },
      });
    }
    return json({ ok: true });
  });
}

export const dynamic = "force-dynamic";
