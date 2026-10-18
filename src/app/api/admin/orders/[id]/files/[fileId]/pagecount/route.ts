import { prisma } from "@/lib/prisma";
import { requireRole } from "@/server/auth";
import { apiError, parseBody, withErrorHandling } from "@/server/api-utils";
import { pageCorrectionSchema } from "@/server/validation";

// REFUSES every page-count correction to a document that is on an order.
//
// An order is priced from its documents' page counts when it is placed (createOrder computes
// totalPages, billablePages and totalAmount, and links each file only while the count it priced is
// unchanged). Changing a count afterwards would change the bill or the printed page count without
// repricing the order, which is the failure this route used to allow: it wrote any count to any
// file on any order, in any state, with no transaction, and no price change.
//
// There is no reviewed, transactional, audited repricing policy in this application yet. Until one
// exists and is approved, this route writes nothing for any order status. The refusal happens after
// authorisation and input validation, and before any database write. Do not add a write here
// without that policy: it must reprice the order, record the change, and be conditional on the
// order's state and the file's count inside one transaction.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> }
) {
  return withErrorHandling(async () => {
    await requireRole("ADMIN", "SUPER_ADMIN");
    const { id, fileId } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f-]{36}$/i.test(fileId)) {
      return apiError("Invalid identifiers.", 400);
    }

    // Validate the body so a malformed request gets the usual 422, then refuse regardless.
    await parseBody(req, pageCorrectionSchema);

    // Read only. The status of the order is deliberately NOT used to decide: the refusal applies
    // to every status, so a concurrent status change cannot open a window.
    const file = await prisma.uploadedFile.findFirst({
      where: { id: fileId, orderId: id },
      select: { id: true },
    });
    if (!file) return apiError("File not found on this order.", 404);

    return apiError(
      "The page count of a document on an order cannot be changed, because the order is priced from it. " +
        "Do not edit the count. Raise it with the owner so the order is handled through the reviewed process.",
      409,
      "ORDER_PRICED"
    );
  });
}

export const dynamic = "force-dynamic";
