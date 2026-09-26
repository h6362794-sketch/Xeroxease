import { redirect } from "next/navigation";
import { getSessionUser, isAdminRole } from "@/server/auth";
import { AdminChrome } from "@/features/admin/admin-chrome";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/admin/login");
  if (!isAdminRole(user.role)) redirect("/dashboard");

  return <AdminChrome user={user}>{children}</AdminChrome>;
}
