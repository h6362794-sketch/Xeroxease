import { getSessionUser } from "@/server/auth";
import { redirect } from "next/navigation";
import { AdminDashboard } from "@/features/admin/admin-dashboard";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const user = await getSessionUser();
  if (!user) redirect("/admin/login");
  return <AdminDashboard role={user.role} />;
}
