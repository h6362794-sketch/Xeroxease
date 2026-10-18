import { getSessionUser } from "@/server/auth";
import { AdminCollection } from "@/features/admin/admin-collection";

export const dynamic = "force-dynamic";

export default async function AdminCollectionPage() {
  const user = await getSessionUser();
  // The override section is shown only to a Super Admin. The API enforces the same rule.
  return <AdminCollection isSuperAdmin={user?.role === "SUPER_ADMIN"} />;
}
