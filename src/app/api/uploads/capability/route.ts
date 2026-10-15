// Capability probe for the browser upload path. Tiny, public-shaped but
// authenticated, and deliberately free of any secret, bucket name or object key.
import { json, withErrorHandling } from "@/server/api-utils";
import { requireUser } from "@/server/auth";
import { describeUploadCapability } from "@/server/direct-upload/capability";

export async function GET() {
  return withErrorHandling(async () => {
    await requireUser();
    return json(describeUploadCapability());
  });
}

export const dynamic = "force-dynamic";
