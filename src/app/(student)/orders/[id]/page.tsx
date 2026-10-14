import { requirePageUser } from "@/server/auth";
import { OrderDetail } from "@/features/student/order-detail";

export const dynamic = "force-dynamic";

// Next.js 15: `params` is a Promise in pages and route handlers.
export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePageUser();
  const { id } = await params;
  return <OrderDetail orderId={id} userId={user.id} />;
}
