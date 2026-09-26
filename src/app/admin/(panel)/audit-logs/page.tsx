import { getSessionUser } from "@/server/auth";
import { redirect } from "next/navigation";
import { AdminAuditLogs } from "@/features/admin/admin-audit-logs";

export const dynamic = "force-dynamic";

export default async function AdminAuditLogsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/admin/login");
  if (user.role !== "SUPER_ADMIN") redirect("/admin");
  return <AdminAuditLogs />;
}
