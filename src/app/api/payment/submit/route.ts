// This route is intentionally empty.
// Payment submissions use /api/payment/submit/[id] (see [id]/route.ts).
import { apiError } from "@/server/api-utils";

export async function POST() {
  return apiError("Use /api/payment/submit/[orderId] instead.", 404);
}

export const dynamic = "force-dynamic";
