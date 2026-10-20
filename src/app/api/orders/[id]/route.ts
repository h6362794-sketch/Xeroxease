import { prisma } from "@/lib/prisma";
import { requireUser, isAdminRole } from "@/server/auth";
import { apiError, json, withErrorHandling } from "@/server/api-utils";
import {
  allowedNextStatuses,
  cancellationExplanation,
  isPaymentEligibleOrderStatus,
  isStudentCancellable,
  stageIndexFor,
  statusLabel,
} from "@/lib/order-status";
import { canStudentSelectPaymentMethod, canStudentSubmitUpiReference } from "@/lib/payment-policy";
import { getSettings } from "@/server/settings";

/**
 * GET /api/orders/:id
 *
 * Shared order detail for the owning student and administrators. The response is
 * built explicitly (never by spreading the row) so internal values such as the
 * collection-token hash or storage keys cannot leak. Admins additionally receive
 * the student record and the authoritative list of valid next statuses.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withErrorHandling(async () => {
    const user = await requireUser();
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return apiError("Invalid order id.", 400);

    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        files: {
          select: {
            id: true,
            originalName: true,
            sizeBytes: true,
            pageCount: true,
            pageCountSource: true,
            status: true,
            analysisStatus: true,
            analysisError: true,
            mimeType: true,
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
          },
        },
        feedback: { select: { id: true, rating: true, comment: true, createdAt: true } },
        user: {
          select: { name: true, email: true, regNo: true, phone: true, branch: true, section: true, year: true },
        },
      },
    });
    if (!order) return apiError("Order not found.", 404);

    const isAdmin = isAdminRole(user.role);
    if (order.userId !== user.id && !isAdmin) {
      // Same answer as a missing order: no existence oracle for other students.
      return apiError("Order not found.", 404);
    }

    const settings = await getSettings();
    const cancellable = isStudentCancellable(order.status, settings.cancellationAllowedStatuses);
    const canSelectMethod = canStudentSelectPaymentMethod({
      orderStatus: order.status,
      paymentStatus: order.paymentStatus,
    });
    const upiDecision = canStudentSubmitUpiReference({
      orderStatus: order.status,
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod ?? null,
    });

    return json({
      order: {
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        statusLabel: statusLabel(order.status),
        stageIndex: stageIndexFor(order.status),
        allowedNextStatuses: isAdmin ? allowedNextStatuses(order.status) : [],
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        acceptedAt: order.acceptedAt,
        deliveredAt: order.deliveredAt,
        rejectedAt: order.rejectedAt,
        rejectionReason: order.rejectionReason,
        completedAt: order.completedAt,
        cancelledAt: order.cancelledAt,
        cancelReason: order.cancelReason,
        paperSize: order.paperSize,
        colorMode: order.colorMode,
        sides: order.sides,
        copies: order.copies,
        pageSelection: order.pageSelection,
        customPages: order.customPages,
        totalPages: order.totalPages,
        billablePages: order.billablePages,
        pricePerPage: Number(order.pricePerPage),
        finishingFee: Number(order.finishingFee),
        finishingOptions: order.finishingOptions,
        totalAmount: Number(order.totalAmount),
        adminNotes: isAdmin ? order.adminNotes : null,
        hasCollectionToken: Boolean(order.collectionTokenHash) && !order.collectionTokenUsedAt,
        files: order.files,
        events: order.events,
        feedback: order.feedback,
        user: isAdmin ? order.user : undefined,
        payment: {
          method: order.paymentMethod,
          status: order.paymentStatus,
          reference: order.paymentRef,
          submittedAt: order.paymentProofAt,
          verifiedAt: order.paymentVerifiedAt,
          note: order.paymentNote,
          history: order.payments.map((p) => ({
            ...p,
            amount: p.amount === null ? null : Number(p.amount),
          })),
        },
        cancellation: {
          allowed: cancellable,
          explanation: cancellationExplanation(order.status),
        },
        paymentControls: {
          canSelectMethod,
          canSubmitUpi: upiDecision.ok,
          blockedReason: upiDecision.ok ? null : upiDecision.message,
          paymentStage: isPaymentEligibleOrderStatus(order.status),
        },
      },
    });
  });
}

export const dynamic = "force-dynamic";
