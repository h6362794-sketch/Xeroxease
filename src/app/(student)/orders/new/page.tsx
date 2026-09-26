import { requireUser } from "@/server/auth";
import { OrderWizard } from "@/features/student/order-wizard";

export const dynamic = "force-dynamic";

export default async function NewOrderPage() {
  const user = await requireUser();
  return <OrderWizard userId={user.id} />;
}
