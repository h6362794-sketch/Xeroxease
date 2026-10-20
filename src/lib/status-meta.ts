import {
  CheckCircle2,
  Clock,
  FileText,
  Printer,
  PackageCheck,
  ShieldCheck,
  XCircle,
  Loader2,
  Banknote,
  ScanLine,
  BadgeCheck,
  Inbox,
  ThumbsUp,
} from "lucide-react";
import { statusLabel } from "./order-status";

/**
 * Presentation metadata only. Labels come from the authoritative status model
 * (`src/lib/order-status.ts`) so the API, timeline and badges always agree.
 */
export const STATUS_META: Record<
  string,
  { label: string; color: string; icon: typeof Clock; description?: string }
> = {
  // Canonical lifecycle
  ORDER_RECEIVED: { label: statusLabel("ORDER_RECEIVED"), color: "text-sky-300 bg-sky-500/10 border-sky-500/20", icon: Inbox },
  ACCEPTED: { label: statusLabel("ACCEPTED"), color: "text-indigo-300 bg-indigo-500/10 border-indigo-500/20", icon: ThumbsUp },
  PRINTING: { label: statusLabel("PRINTING"), color: "text-indigo-300 bg-indigo-500/10 border-indigo-500/20", icon: Printer },
  READY_FOR_PICKUP: { label: statusLabel("READY_FOR_PICKUP"), color: "text-emerald-300 bg-emerald-500/10 border-emerald-500/20", icon: PackageCheck },
  DELIVERED: { label: statusLabel("DELIVERED"), color: "text-emerald-300 bg-emerald-500/10 border-emerald-500/20", icon: CheckCircle2 },
  REJECTED: { label: statusLabel("REJECTED"), color: "text-red-300 bg-red-500/10 border-red-500/20", icon: XCircle },

  // Legacy statuses
  ORDER_PLACED: { label: statusLabel("ORDER_PLACED"), color: "text-sky-300 bg-sky-500/10 border-sky-500/20", icon: FileText },
  PAYMENT_PENDING: { label: statusLabel("PAYMENT_PENDING"), color: "text-amber-300 bg-amber-500/10 border-amber-500/20", icon: Banknote },
  PAYMENT_UNDER_REVIEW: { label: statusLabel("PAYMENT_UNDER_REVIEW"), color: "text-amber-300 bg-amber-500/10 border-amber-500/20", icon: ScanLine },
  PAYMENT_CONFIRMED: { label: statusLabel("PAYMENT_CONFIRMED"), color: "text-emerald-300 bg-emerald-500/10 border-emerald-500/20", icon: BadgeCheck },
  DOCUMENTS_RECEIVED: { label: statusLabel("DOCUMENTS_RECEIVED"), color: "text-sky-300 bg-sky-500/10 border-sky-500/20", icon: FileText },
  PROCESSING: { label: statusLabel("PROCESSING"), color: "text-indigo-300 bg-indigo-500/10 border-indigo-500/20", icon: Loader2 },
  QUALITY_CHECK: { label: statusLabel("QUALITY_CHECK"), color: "text-violet-300 bg-violet-500/10 border-violet-500/20", icon: ShieldCheck },
  READY_FOR_COLLECTION: { label: statusLabel("READY_FOR_COLLECTION"), color: "text-emerald-300 bg-emerald-500/10 border-emerald-500/20", icon: PackageCheck },
  COMPLETED: { label: statusLabel("COMPLETED"), color: "text-emerald-300 bg-emerald-500/10 border-emerald-500/20", icon: CheckCircle2 },
  CANCELLED: { label: statusLabel("CANCELLED"), color: "text-red-300 bg-red-500/10 border-red-500/20", icon: XCircle },
  FAILED: { label: statusLabel("FAILED"), color: "text-red-300 bg-red-500/10 border-red-500/20", icon: XCircle },
};

export const PAYMENT_STATUS_META: Record<
  string,
  { label: string; color: string; icon: typeof Clock }
> = {
  PAYMENT_PENDING: { label: "Payment Pending", color: "text-amber-300 bg-amber-500/10 border-amber-500/20", icon: Clock },
  PAYMENT_PROOF_SUBMITTED: { label: "Reference Submitted", color: "text-sky-300 bg-sky-500/10 border-sky-500/20", icon: FileText },
  PAYMENT_UNDER_REVIEW: { label: "Under Verification", color: "text-amber-300 bg-amber-500/10 border-amber-500/20", icon: ScanLine },
  PAYMENT_CONFIRMED: { label: "Paid", color: "text-emerald-300 bg-emerald-500/10 border-emerald-500/20", icon: BadgeCheck },
  PAYMENT_REJECTED: { label: "Payment Rejected", color: "text-red-300 bg-red-500/10 border-red-500/20", icon: XCircle },
  PAYMENT_FAILED: { label: "Payment Failed", color: "text-red-300 bg-red-500/10 border-red-500/20", icon: XCircle },
};

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  CASH_ON_DELIVERY: "Cash on Delivery / Pay at Pickup",
  UPI: "UPI QR Payment",
};

export const PAYMENT_METHOD_SHORT: Record<string, string> = {
  CASH_ON_DELIVERY: "Cash at pickup",
  UPI: "UPI",
};

export function statusMeta(status: string) {
  return STATUS_META[status] ?? { label: statusLabel(status), color: "text-slate-300 bg-slate-500/10 border-slate-500/20", icon: Clock };
}

export function paymentMethodLabel(method: string | null | undefined): string {
  if (!method) return "Not selected";
  return PAYMENT_METHOD_LABELS[method] ?? method;
}
