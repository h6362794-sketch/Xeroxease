import { requireUser } from "@/server/auth";
import { OrderDetail } from "@/features/student/order-detail";

export const dynamic = "force-dynamic";

export default async function OrderDetailPage({ params }: { params: { id: string } }) {
  const user = await requireUser();
  return <OrderDetail orderId={params.id} userId={user.id} />;
}
