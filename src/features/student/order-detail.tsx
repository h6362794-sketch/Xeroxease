"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  ArrowLeft, Download, QrCode, Copy, Check, Star, XCircle,
  RefreshCw, ShieldCheck, FileText,
} from "lucide-react";
import { Button, Card, FieldError, Input, Label, Modal, RatingInput, Skeleton, Textarea, EmptyState } from "@/components/ui";
import { StatusBadge, PaymentStatusBadge } from "@/components/status-badge";
import { OrderTimeline } from "@/components/order-timeline";
import { PaymentForm } from "@/features/student/payment-form";
import { useToast } from "@/components/toast";
import { api, ApiError } from "@/lib/api-client";
import { formatCurrencyINR, formatDate, formatBytes } from "@/lib/utils";

interface OrderData {
  id: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  paperSize: string;
  colorMode: string;
  sides: string;
  copies: number;
  pageSelection: string;
  customPages: string | null;
  totalPages: number;
  billablePages: number;
  pricePerPage: number;
  finishingFee: number;
  totalAmount: number;
  paymentRef: string | null;
  /** The desk's reason for rejecting the current reference; present only while it is rejected. */
  rejectionReason?: string | null;
  adminNotes: string | null;
  createdAt: string;
  completedAt: string | null;
  hasCollectionToken: boolean;
  files: {
    id: string;
    originalName: string;
    sizeBytes: number;
    pageCount: number | null;
    pageCountSource: string | null;
    analysisStatus: string;
    analysisError: string | null;
    /** Set when the document was deleted under the retention policy. */
    purgedAt?: string | null;
  }[];
  events: { id: string; type: string; message: string | null; createdAt: string }[];
  feedback: { id: string; rating: number; comment: string | null } | null;
}

export function OrderDetail({ orderId }: { orderId: string; userId: string }) {
  const [order, setOrder] = useState<OrderData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [fbOpen, setFbOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [fbBusy, setFbBusy] = useState(false);
  const [collectionToken, setCollectionToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const data = await api<{ order: OrderData }>(`/api/orders/${orderId}`);
      setOrder(data.order);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    }
  }, [orderId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 20000); // light polling for live status
    return () => clearInterval(t);
  }, [load]);

  async function fetchCollectionToken() {
    try {
      const res = await api<{ token: string }>(`/api/orders/${orderId}/collection-token`);
      setCollectionToken(res.token);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not load collection code.", "error");
    }
  }

  async function doCancel() {
    setCancelling(true);
    try {
      await api(`/api/orders/${orderId}/cancel`, { method: "POST", json: { reason: cancelReason } });
      setCancelOpen(false);
      toast("Order cancelled.", "success");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not cancel the order.", "error");
    } finally {
      setCancelling(false);
    }
  }

  async function submitFeedback() {
    setFbBusy(true);
    try {
      await api(`/api/orders/${orderId}/feedback`, { method: "POST", json: { rating, comment } });
      setFbOpen(false);
      toast("Thanks for your feedback!", "success");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not submit feedback.", "error");
    } finally {
      setFbBusy(false);
    }
  }

  const cancellable = ["ORDER_PLACED", "PAYMENT_PENDING", "PAYMENT_UNDER_REVIEW"].includes(order?.status ?? "");
  const canPay = order && ["PAYMENT_PENDING", "PAYMENT_REJECTED", "PAYMENT_FAILED"].includes(order.paymentStatus);
  const canCollect = order?.status === "READY_FOR_COLLECTION" && !order.feedback;

  if (error) {
    return (
      <div className="max-w-2xl mx-auto">
        <Link href="/orders" className="inline-flex items-center gap-2 text-sm text-zinc-400 hover:text-white mb-4">
          <ArrowLeft className="h-4 w-4" /> Back to orders
        </Link>
        <Card><EmptyState title="Order unavailable" sub={error} icon={<XCircle className="h-8 w-8" />} /></Card>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="max-w-2xl mx-auto space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-5">
      <Link href="/orders" className="inline-flex items-center gap-2 text-sm text-zinc-400 hover:text-white transition-colors">
        <ArrowLeft className="h-4 w-4" /> Back to orders
      </Link>

      {/* Header */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-extrabold text-white tracking-tight">{order.orderNumber}</h1>
            <p className="text-xs text-zinc-500 mt-1">Placed {formatDate(order.createdAt)}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusBadge status={order.status} />
            <PaymentStatusBadge status={order.paymentStatus} />
          </div>
        </div>
      </motion.div>

      {/* Timeline */}
      <Card>
        <OrderTimeline status={order.status} />
        {order.status === "READY_FOR_COLLECTION" && (
          <div className="mt-4 pt-4 border-t border-white/10">
            {collectionToken ? (
              <div className="text-center space-y-3">
                <p className="text-sm font-semibold text-emerald-300 flex items-center justify-center gap-2">
                  <QrCode className="h-4 w-4" /> Show this at the counter
                </p>
                <div className="mx-auto w-fit glass rounded-xl px-6 py-4">
                  <p className="font-mono text-[10px] text-zinc-400 break-all max-w-[260px]">{collectionToken}</p>
                </div>
                <Button
                  variant="ghost" size="sm"
                  onClick={() => { navigator.clipboard.writeText(collectionToken); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                  icon={copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                >
                  Copy code
                </Button>
              </div>
            ) : (
              <Button variant="ghost" className="w-full" onClick={fetchCollectionToken} icon={<QrCode className="h-4 w-4" />}>
                Reveal collection code
              </Button>
            )}
          </div>
        )}
      </Card>

      {/* Payment panel */}
      {canPay && (
        // The payment form is the same one the order wizard uses, so a student can pay, or
        // correct a rejected reference and resubmit, from this page at any time.
        <PaymentForm
          orderId={order.id}
          orderNumber={order.orderNumber}
          totalAmount={order.totalAmount}
          rejectionReason={order.paymentStatus === "PAYMENT_REJECTED" ? (order.rejectionReason ?? "") : null}
          onSubmitted={load}
        />
      )}
      {!canPay && (order.paymentStatus === "PAYMENT_UNDER_REVIEW" || order.paymentStatus === "PAYMENT_PROOF_SUBMITTED") && (
        <Card className="space-y-4">
          <h2 className="font-bold text-white">Payment</h2>
          <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
            <ShieldCheck className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
            <p className="text-sm text-amber-200">
              Your payment reference {order.paymentRef ? <span className="font-mono">({order.paymentRef.slice(-4)})</span> : null} is under review by the print desk.
              You&apos;ll be notified once it&apos;s confirmed.
            </p>
          </div>
        </Card>
      )}

      {/* Details */}
      <Card className="space-y-3">
        <h2 className="font-bold text-white mb-2">Order details</h2>
        <Row label="Paper" value={`${order.paperSize} · ${order.colorMode === "COLOR" ? "Colour" : "B&W"} · ${order.sides === "DOUBLE" ? "Double side" : "Single side"}`} />
        <Row label="Copies" value={String(order.copies)} />
        <Row label="Pages" value={order.pageSelection === "CUSTOM" ? (order.customPages ?? "Custom") : "All pages"} />
        <Row label="Verified pages" value={`${order.totalPages} (billable ${order.billablePages})`} />
        <Row label="Print rate" value={`${formatCurrencyINR(order.pricePerPage)} / page`} />
        {order.finishingFee > 0 && <Row label="Finishing" value={formatCurrencyINR(order.finishingFee)} />}
        <div className="border-t border-white/10 pt-3 flex justify-between items-center">
          <span className="font-bold text-white">Total</span>
          <span className="text-xl font-extrabold text-white">{formatCurrencyINR(order.totalAmount)}</span>
        </div>
      </Card>

      {/* Files */}
      <Card className="space-y-3">
        <h2 className="font-bold text-white mb-1">Documents</h2>
        {order.files.map((f) => (
          <div key={f.id} className="flex items-center justify-between gap-3 border-t border-white/5 pt-3 first:border-0 first:pt-0">
            <div className="flex items-center gap-3 min-w-0">
              <FileText className="h-4 w-4 text-zinc-500 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm text-white truncate">{f.originalName}</p>
                <p className="text-xs text-zinc-500">
                  {formatBytes(f.sizeBytes)} · {f.pageCount != null ? `${f.pageCount} pages` : "page count pending"}
                  {f.pageCountSource === "ADMIN_VERIFIED" ? " (admin verified)" : ""}
                </p>
              </div>
            </div>
            {f.purgedAt ? (
              <span className="text-[11px] text-zinc-500 shrink-0 text-right">Deleted under<br />retention policy</span>
            ) : (
            <a
              href={`/api/files/${f.id}/download`}
              /* `noreferrer`: the route answers with a short-lived signed storage URL,
                 and a referrer header would hand it to anything the tab links on to. */
              target="_blank" rel="noopener noreferrer"
              className="rounded-lg p-2 text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
              aria-label={`Download ${f.originalName}`}
            >
              <Download className="h-4 w-4" />
            </a>
            )}
          </div>
        ))}
      </Card>

      {/* Actions */}
      <div className="flex flex-wrap gap-3">
        <a href={`/api/invoices/${order.id}`} target="_blank" rel="noopener" className="flex-1 min-w-[140px]">
          <Button variant="ghost" className="w-full" icon={<Download className="h-4 w-4" />}>Download Invoice</Button>
        </a>
        {cancellable && (
          <Button variant="danger" className="flex-1 min-w-[140px]" onClick={() => setCancelOpen(true)} icon={<XCircle className="h-4 w-4" />}>
            Cancel order
          </Button>
        )}
        {order.status === "COMPLETED" && !order.feedback && (
          <Button className="flex-1 min-w-[140px]" onClick={() => setFbOpen(true)} icon={<Star className="h-4 w-4" />}>
            Rate this order
          </Button>
        )}
        {order.status === "COMPLETED" && order.feedback && (
          <Card className="flex-1 min-w-[200px]">
            <div className="flex items-center gap-2">
              {[1, 2, 3, 4, 5].map((n) => (
                <Star key={n} className={`h-4 w-4 ${n <= order.feedback!.rating ? "fill-amber-400 text-amber-400" : "text-zinc-700"}`} />
              ))}
            </div>
            {order.feedback.comment && <p className="text-xs text-zinc-400 mt-2">{order.feedback.comment}</p>}
          </Card>
        )}
      </div>

      <p className="text-[11px] text-zinc-600 flex items-center gap-1.5">
        <RefreshCw className="h-3 w-3" /> This page refreshes automatically with status changes.
      </p>

      {/* Cancel dialog */}
      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title="Cancel this order?">
        <p className="text-sm text-zinc-300 mb-4">
          This can&apos;t be undone. If you&apos;ve already paid, the desk will handle the refund manually.
        </p>
        <Label htmlFor="reason">Reason (optional)</Label>
        <Textarea id="reason" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="Tell us why you're cancelling…" />
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setCancelOpen(false)}>Keep order</Button>
          <Button variant="danger" size="sm" onClick={doCancel} loading={cancelling}>Cancel order</Button>
        </div>
      </Modal>

      {/* Feedback dialog */}
      <Modal open={fbOpen} onClose={() => setFbOpen(false)} title="Rate your order">
        <div className="space-y-4">
          <div className="flex justify-center py-2">
            <RatingInput value={rating} onChange={setRating} size={34} />
          </div>
          <div>
            <Label htmlFor="fbcomment">Comments (optional)</Label>
            <Textarea id="fbcomment" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="How was the print quality and service?" />
          </div>
          <FieldError message={rating === 0 ? "Please select a star rating." : undefined} />
          <Button className="w-full" onClick={submitFeedback} loading={fbBusy} disabled={rating === 0}>
            Submit feedback
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 text-sm">
      <span className="text-zinc-500">{label}</span>
      <span className="text-white font-medium text-right">{value}</span>
    </div>
  );
}
