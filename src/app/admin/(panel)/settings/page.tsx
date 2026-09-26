import { getSessionUser } from "@/server/auth";
import { redirect } from "next/navigation";
import { AdminSettings } from "@/features/admin/admin-settings";

export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/admin/login");
  if (user.role !== "SUPER_ADMIN") redirect("/admin");
  return <AdminSettings />;
}
