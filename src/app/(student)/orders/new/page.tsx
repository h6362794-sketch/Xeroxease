import { requirePageUser } from "@/server/auth";
import { OrderWizard } from "@/features/student/order-wizard";

export const dynamic = "force-dynamic";

export default async function NewOrderPage() {
  const user = await requirePageUser();
  return <OrderWizard userId={user.id} />;
}
