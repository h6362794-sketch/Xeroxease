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
} from "lucide-react";

export const STATUS_META: Record<
  string,
  { label: string; color: string; icon: typeof Clock; description?: string }
> = {
  ORDER_PLACED: { label: "Order Placed", color: "text-sky-300 bg-sky-500/10 border-sky-500/20", icon: FileText },
  PAYMENT_PENDING: { label: "Payment Pending", color: "text-amber-300 bg-amber-500/10 border-amber-500/20", icon: Banknote },
  PAYMENT_UNDER_REVIEW: { label: "Payment Under Review", color: "text-amber-300 bg-amber-500/10 border-amber-500/20", icon: ScanLine },
  PAYMENT_CONFIRMED: { label: "Payment Confirmed", color: "text-emerald-300 bg-emerald-500/10 border-emerald-500/20", icon: BadgeCheck },
  DOCUMENTS_RECEIVED: { label: "Documents Received", color: "text-sky-300 bg-sky-500/10 border-sky-500/20", icon: FileText },
  PROCESSING: { label: "Processing", color: "text-indigo-300 bg-indigo-500/10 border-indigo-500/20", icon: Loader2 },
  PRINTING: { label: "Printing", color: "text-indigo-300 bg-indigo-500/10 border-indigo-500/20", icon: Printer },
  QUALITY_CHECK: { label: "Quality Check", color: "text-violet-300 bg-violet-500/10 border-violet-500/20", icon: ShieldCheck },
  READY_FOR_COLLECTION: { label: "Ready for Collection", color: "text-emerald-300 bg-emerald-500/10 border-emerald-500/20", icon: PackageCheck },
  COMPLETED: { label: "Completed", color: "text-emerald-300 bg-emerald-500/10 border-emerald-500/20", icon: CheckCircle2 },
  CANCELLED: { label: "Cancelled", color: "text-red-300 bg-red-500/10 border-red-500/20", icon: XCircle },
  FAILED: { label: "Failed", color: "text-red-300 bg-red-500/10 border-red-500/20", icon: XCircle },
};

export const PAYMENT_STATUS_META: Record<
  string,
  { label: string; color: string; icon: typeof Clock }
> = {
  PAYMENT_PENDING: { label: "Payment Pending", color: "text-amber-300 bg-amber-500/10 border-amber-500/20", icon: Clock },
  PAYMENT_PROOF_SUBMITTED: { label: "Proof Submitted", color: "text-sky-300 bg-sky-500/10 border-sky-500/20", icon: FileText },
  PAYMENT_UNDER_REVIEW: { label: "Under Review", color: "text-amber-300 bg-amber-500/10 border-amber-500/20", icon: ScanLine },
  PAYMENT_CONFIRMED: { label: "Confirmed", color: "text-emerald-300 bg-emerald-500/10 border-emerald-500/20", icon: BadgeCheck },
  PAYMENT_REJECTED: { label: "Rejected", color: "text-red-300 bg-red-500/10 border-red-500/20", icon: XCircle },
  PAYMENT_FAILED: { label: "Failed", color: "text-red-300 bg-red-500/10 border-red-500/20", icon: XCircle },
};

export function statusMeta(status: string) {
  return STATUS_META[status] ?? { label: status, color: "text-slate-300 bg-slate-500/10 border-slate-500/20", icon: Clock };
}
