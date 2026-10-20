import { notFound, redirect } from "next/navigation";
import { getSessionUser, isAdminRole } from "@/server/auth";
import { AdminOrderDetail } from "@/features/admin/admin-order-detail";

export const dynamic = "force-dynamic";

export default async function AdminOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/admin/login");
  if (!isAdminRole(user.role)) redirect("/dashboard");

  const { id } = await params;
  // Reject malformed ids before the client can make an API call with them.
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  return <AdminOrderDetail orderId={id} />;
}
