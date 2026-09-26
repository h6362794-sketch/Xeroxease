import { prisma } from "@/lib/prisma";

export interface AuditEntry {
  actorId?: string | null;
  actorRole?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}

/** Immutable audit trail for privileged actions. Never log secrets. */
export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: entry.actorId ?? null,
        actorRole: entry.actorRole ?? null,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        metadata: (entry.metadata ?? undefined) as never,
        ip: entry.ip?.slice(0, 64),
        userAgent: entry.userAgent?.slice(0, 255),
      },
    });
  } catch (err) {
    // Audit must never break the request flow; surface in server logs.
    console.error("[audit] failed to write entry", err instanceof Error ? err.message : err);
  }
}
