import { prisma } from "@/lib/prisma";
import { requireRole } from "@/server/auth";
import { apiError, enforceRateLimit, json, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { allowedNextStatuses, cancellationExplanation, stageIndexFor, statusLabel } from "@/lib/order-status";

/**
 * GET /api/admin/orders/:id
 *
 * Complete, admin-authorized order record for the detail/lookup screens. Storage
 * keys and collection-token hashes are never included. Files are listed with the
 * metadata needed to preview/download them through the separate, order-scoped
 * authorization endpoint.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withErrorHandling(async () => {
    const user = await requireRole("ADMIN", "SUPER_ADMIN");
    const limited = await enforceRateLimit(req, RATE_LIMITS.admin, "admin-order-detail", user.id);
    if (limited) return limited;

    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return apiError("Invalid order id.", 400);

    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            regNo: true,
            phone: true,
            branch: true,
            section: true,
            year: true,
          },
        },
        files: {
          select: {
            id: true,
            originalName: true,
            mimeType: true,
            sizeBytes: true,
            status: true,
            pageCount: true,
            pageCountSource: true,
            analysisStatus: true,
            analysisError: true,
            analyzedAt: true,
            createdAt: true,
          },
          orderBy: { createdAt: "asc" },
        },
        events: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            type: true,
            fromStatus: true,
            toStatus: true,
            message: true,
            actorId: true,
            actorRole: true,
            createdAt: true,
          },
        },
        payments: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            type: true,
            amount: true,
            reference: true,
            note: true,
            actorRole: true,
            createdAt: true,
            actor: { select: { id: true, name: true } },
          },
        },
        feedback: { select: { id: true, rating: true, comment: true, createdAt: true } },
      },
    });

    if (!order) return apiError("Order not found.", 404);

    // Resolve event actor names without exposing unrelated user records.
    const actorIds = [...new Set(order.events.map((e) => e.actorId).filter(Boolean))] as string[];
    const actors = actorIds.length
      ? await prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, name: true, role: true },
        })
      : [];
    const actorMap = new Map(actors.map((a) => [a.id, a]));

    return json({
      order: {
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        statusLabel: statusLabel(order.status),
        statusHistory: order.events.map((e) => ({
          ...e,
          actorName: e.actorId ? actorMap.get(e.actorId)?.name ?? null : null,
        })),
        allowedNextStatuses: allowedNextStatuses(order.status),
        stageIndex: stageIndexFor(order.status),
        cancellationExplanation: cancellationExplanation(order.status),
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        acceptedAt: order.acceptedAt,
        rejectedAt: order.rejectedAt,
        rejectionReason: order.rejectionReason,
        deliveredAt: order.deliveredAt,
        completedAt: order.completedAt,
        cancelledAt: order.cancelledAt,
        cancelReason: order.cancelReason,
        adminNotes: order.adminNotes,
        totalAmount: Number(order.totalAmount),
        pricePerPage: Number(order.pricePerPage),
        finishingFee: Number(order.finishingFee),
        pricingSnapshot: order.pricingSnapshot,
        finishingOptions: order.finishingOptions,
        totalPages: order.totalPages,
        billablePages: order.billablePages,
        paperSize: order.paperSize,
        colorMode: order.colorMode,
        sides: order.sides,
        copies: order.copies,
        pageSelection: order.pageSelection,
        customPages: order.customPages,
        student: order.user,
        files: order.files.map((f) => ({
          ...f,
          pageCountVerified:
            typeof f.pageCount === "number" &&
            f.status === "COMPLETED" &&
            ["DOCUMENT_PARSER", "AI_ANALYSIS", "ADMIN_VERIFIED", "USER_CONFIRMED"].includes(
              f.pageCountSource ?? ""
            ),
        })),
        payment: {
          method: order.paymentMethod,
          status: order.paymentStatus,
          reference: order.paymentRef,
          submittedAt: order.paymentProofAt,
          verifiedBy: order.paymentVerifiedBy,
          verifiedAt: order.paymentVerifiedAt,
          note: order.paymentNote,
          history: order.payments.map((p) => ({
            ...p,
            amount: p.amount === null ? null : Number(p.amount),
          })),
        },
        feedback: order.feedback,
      },
    });
  });
}

export const dynamic = "force-dynamic";
