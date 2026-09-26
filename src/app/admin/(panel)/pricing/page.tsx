import { getSessionUser } from "@/server/auth";
import { redirect } from "next/navigation";
import { AdminPricing } from "@/features/admin/admin-pricing";

export const dynamic = "force-dynamic";

export default async function AdminPricingPage() {
  const user = await getSessionUser();
  if (!user) redirect("/admin/login");
  return <AdminPricing canEdit={user.role === "SUPER_ADMIN"} />;
}
