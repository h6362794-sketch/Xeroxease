import { getSessionUser } from "@/server/auth";
import { redirect } from "next/navigation";
import { AdminUsers } from "@/features/admin/admin-users";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  const user = await getSessionUser();
  if (!user) redirect("/admin/login");
  return <AdminUsers canManage={user.role === "SUPER_ADMIN"} />;
}
