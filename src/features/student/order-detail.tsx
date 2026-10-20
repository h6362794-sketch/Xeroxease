"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  ArrowLeft, Download, QrCode, Copy, Check, Star, XCircle,
  RefreshCw, FileText, Clock, Banknote, BadgeCheck, Lock, AlertTriangle, Eye,
} from "lucide-react";
import { Button, Card, FieldError, Input, Label, Modal, RatingInput, Skeleton, Textarea, EmptyState } from "@/components/ui";
import { StatusBadge, PaymentStatusBadge } from "@/components/status-badge";
import { OrderTimeline } from "@/components/order-timeline";
import { useToast } from "@/components/toast";
import { api, ApiError } from "@/lib/api-client";
import { formatCurrencyINR, formatDate, formatBytes, timeAgo } from "@/lib/utils";
import { paymentMethodLabel } from "@/lib/status-meta";
import { maskReference } from "@/lib/payment-policy";

interface OrderData {
  id: string;
  orderNumber: string;
  status: string;
  statusLabel: string;
  stageIndex: number;
  createdAt: string;
  updatedAt: string;
  acceptedAt: string | null;
  deliveredAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
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
  finishingOptions: string[];
  totalAmount: number;
  hasCollectionToken: boolean;
  files: {
    id: string;
    originalName: string;
    sizeBytes: number;
    pageCount: number | null;
    pageCountSource: string | null;
    status: string;
    analysisStatus: string;
    analysisError: string | null;
    mimeType: string;
    createdAt: string;
  }[];
  events: {
    id: string;
    type: string;
    fromStatus: string | null;
    toStatus: string | null;
    message: string | null;
    actorRole: string | null;
    createdAt: string;
  }[];
  payment: {
    method: string | null;
    status: string;
    reference: string | null;
    submittedAt: string | null;
    verifiedAt: string | null;
    note: string | null;
    history: { id: string; type: string; amount: number | null; reference: string | null; note: string | null; actorRole: string | null; createdAt: string }[];
  };
  cancellation: { allowed: boolean; explanation: string | null };
  paymentControls: { canSelectMethod: boolean; canSubmitUpi: boolean; blockedReason: string | null; paymentStage: boolean };
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
  const [payBusy, setPayBusy] = useState(false);
  const [reference, setReference] = useState("");
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const [qr, setQr] = useState<{ enabled: boolean; qrUrl?: string; instructions: string; accountDisplay: string } | null>(null);

  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const data = await api<{ order: OrderData }>(`/api/orders/${orderId}`);
      setOrder(data.order);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    }
  }, [orderId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 20000); // light polling for live status
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    api<{ enabled: boolean; qrUrl?: string; instructions: string; accountDisplay: string }>("/api/payment/qr")
      .then(setQr)
      .catch(() => setQr({ enabled: false, instructions: "Contact the print desk for payment details.", accountDisplay: "XeroxEase Print Desk" }));
  }, []);

  async function fetchCollectionToken() {
    try {
      const res = await api<{ token: string }>(`/api/orders/${orderId}/collection-token`);
      setCollectionToken(res.token);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not load collection code.", "error");
    }
  }

  async function chooseMethod(method: "CASH_ON_DELIVERY" | "UPI") {
    setPayBusy(true);
    try {
      await api(`/api/orders/${orderId}/payment-method`, { method: "POST", json: { method } });
      toast(
        method === "UPI"
          ? "UPI selected. Pay via the QR, then submit your reference."
          : "Cash at pickup selected. Your order is not marked paid until the desk receives it.",
        "success"
      );
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not save the payment method.", "error");
    } finally {
      setPayBusy(false);
    }
  }

  async function submitReference() {
    setReferenceError(null);
    if (reference.trim().length < 4) {
      setReferenceError("Enter the transaction reference (at least 4 characters).");
      return;
    }
    setPayBusy(true);
    try {
      await api(`/api/payment/submit/${orderId}`, { method: "POST", json: { reference } });
      setReference("");
      toast("Reference submitted. The desk will verify it — payment is not confirmed yet.", "success");
      await load();
    } catch (err) {
      setReferenceError(err instanceof ApiError ? err.message : "Could not submit the reference.");
    } finally {
      setPayBusy(false);
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
      load();
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

  if (error) {
    return (
      <div className="max-w-2xl mx-auto">
        <Link href="/orders" className="inline-flex min-h-11 items-center gap-2 text-sm text-zinc-400 hover:text-white mb-4">
          <ArrowLeft className="h-4 w-4" /> Back to orders
        </Link>
        <Card><EmptyState title="Order unavailable" sub={error} icon={<XCircle className="h-8 w-8" />} /></Card>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="max-w-2xl mx-auto space-y-4" aria-busy="true" aria-label="Loading order">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }

  const terminal = ["DELIVERED", "COMPLETED", "REJECTED", "CANCELLED", "FAILED"].includes(order.status);
  const canRate = ["DELIVERED", "COMPLETED"].includes(order.status) && !order.feedback;
  const method = order.payment.method;
  const underReview = ["PAYMENT_UNDER_REVIEW", "PAYMENT_PROOF_SUBMITTED"].includes(order.payment.status);
  const paid = order.payment.status === "PAYMENT_CONFIRMED";
  const rejected = ["PAYMENT_REJECTED", "PAYMENT_FAILED"].includes(order.payment.status);
  const canPickMethod = order.paymentControls.canSelectMethod && !underReview;
  const canSubmitUpi =
    order.paymentControls.canSubmitUpi && method === "UPI" && !underReview && !paid;
  const changeBlocked = underReview && method === "UPI";

  return (
    <div className="max-w-2xl mx-auto space-y-5 min-w-0">
      <Link href="/orders" className="inline-flex min-h-11 items-center gap-2 text-sm text-zinc-400 hover:text-white transition-colors">
        <ArrowLeft className="h-4 w-4" /> Back to orders
      </Link>

      {/* Header */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-extrabold text-white tracking-tight break-words">{order.orderNumber}</h1>
            <p className="text-xs text-zinc-500 mt-1">
              Placed {formatDate(order.createdAt)} · last updated {timeAgo(order.updatedAt)}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusBadge status={order.status} />
            <PaymentStatusBadge status={order.payment.status} />
          </div>
        </div>
      </motion.div>

      {/* Timeline */}
      <Card>
        <OrderTimeline status={order.status} events={order.events} rejectionReason={order.rejectionReason} />
        {order.status === "READY_FOR_PICKUP" && (
          <div className="mt-4 pt-4 border-t border-white/10">
            {collectionToken ? (
              <div className="text-center space-y-3">
                <p className="text-sm font-semibold text-emerald-300 flex items-center justify-center gap-2">
                  <QrCode className="h-4 w-4" /> Show this at the counter
                </p>
                <div className="mx-auto w-fit glass rounded-xl px-6 py-4 max-w-full">
                  <p className="font-mono text-[10px] text-zinc-400 break-all max-w-[260px]">{collectionToken}</p>
                </div>
                <Button
                  variant="ghost" size="md"
                  onClick={() => { navigator.clipboard.writeText(collectionToken); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                  icon={copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                >
                  Copy code
                </Button>
              </div>
            ) : (
              <Button variant="ghost" className="w-full min-h-11" onClick={fetchCollectionToken} icon={<QrCode className="h-4 w-4" />}>
                Reveal collection code
              </Button>
            )}
          </div>
        )}
      </Card>

      {/* Payment */}
      {!["REJECTED", "CANCELLED", "FAILED"].includes(order.status) && (
        <Card className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-bold text-white">Payment</h2>
            <PaymentStatusBadge status={order.payment.status} />
          </div>

          {!order.paymentControls.paymentStage ? (
            <div className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-4">
              <Lock className="h-5 w-5 text-zinc-400 shrink-0 mt-0.5" aria-hidden="true" />
              <div className="text-sm text-zinc-300">
                <p className="font-semibold text-white">Payment options unlock after acceptance.</p>
                <p className="mt-1 text-zinc-400">
                  You can choose Cash at Pickup or UPI once the print desk accepts your order. Nothing is charged now.
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="rounded-xl bg-white/[0.03] p-4">
                <p className="text-xs uppercase tracking-wider text-zinc-500 font-semibold">Amount due (server-calculated)</p>
                <p className="text-2xl font-extrabold text-white mt-1">{formatCurrencyINR(order.totalAmount)}</p>
                <p className="text-[11px] text-zinc-500 mt-1">This amount was fixed when your order was created.</p>
              </div>

              {paid ? (
                <div className="flex items-start gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
                  <BadgeCheck className="h-5 w-5 text-emerald-400 shrink-0 mt-0.5" aria-hidden="true" />
                  <div className="text-sm text-emerald-100">
                    <p className="font-semibold">Payment confirmed</p>
                    <p className="text-emerald-200/90 mt-0.5">
                      {paymentMethodLabel(method)} · {formatCurrencyINR(order.totalAmount)}
                      {order.payment.verifiedAt ? ` · recorded ${formatDate(order.payment.verifiedAt)}` : ""}
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  <fieldset disabled={payBusy || !canPickMethod} className="space-y-2">
                    <legend className="text-sm font-semibold text-white mb-2">Choose how you will pay</legend>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <button
                        type="button"
                        onClick={() => chooseMethod("CASH_ON_DELIVERY")}
                        aria-pressed={method === "CASH_ON_DELIVERY"}
                        className={`rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60 ${
                          method === "CASH_ON_DELIVERY" ? "border-[#7c5cff] bg-[#7c5cff]/10" : "border-white/15 hover:border-white/30"
                        }`}
                      >
                        <span className="flex items-center gap-2 text-sm font-semibold text-white">
                          <Banknote className="h-4 w-4 text-[#b49aff]" aria-hidden="true" /> Cash on Delivery / Pay at Pickup
                        </span>
                        <span className="mt-1 block text-[11px] text-zinc-400">
                          Pay at the desk when you collect. The desk records receipt; selecting this does not mark you paid.
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => chooseMethod("UPI")}
                        aria-pressed={method === "UPI"}
                        className={`rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60 ${
                          method === "UPI" ? "border-[#7c5cff] bg-[#7c5cff]/10" : "border-white/15 hover:border-white/30"
                        }`}
                      >
                        <span className="flex items-center gap-2 text-sm font-semibold text-white">
                          <QrCode className="h-4 w-4 text-[#b49aff]" aria-hidden="true" /> UPI QR Payment
                        </span>
                        <span className="mt-1 block text-[11px] text-zinc-400">
                          Scan the desk&apos;s QR and submit the transaction reference for verification.
                        </span>
                      </button>
                    </div>
                  </fieldset>

                  {changeBlocked && (
                    <p className="text-xs text-amber-300">
                      A reference is under verification. You can change the method after the desk reviews it.
                    </p>
                  )}

                  {method === "UPI" && !paid && (
                    <div className="space-y-4 rounded-xl border border-white/10 p-4">
                      {qr?.enabled && qr.qrUrl ? (
                        <div className="text-center space-y-2">
                          <p className="text-xs text-zinc-400">Scan with any UPI app</p>
                          <div className="mx-auto w-fit max-w-full rounded-2xl bg-white p-3">
                            <img src={qr.qrUrl} alt="UPI payment QR code for the XeroxEase print desk" className="h-48 w-48 max-w-full object-contain" />
                          </div>
                          <p className="text-xs text-zinc-400 break-words">{qr.instructions}</p>
                          <p className="text-xs text-zinc-500 break-words">{qr.accountDisplay}</p>
                        </div>
                      ) : (
                        <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
                          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
                          <span>The payment QR is not configured yet. Please pay at the desk or check back shortly.</span>
                        </div>
                      )}

                      {underReview ? (
                        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">
                          <p className="font-semibold flex items-center gap-2"><Clock className="h-4 w-4" /> Reference submitted</p>
                          <p className="mt-1 text-amber-200/90">
                            {maskReference(order.payment.reference)} · submitted {order.payment.submittedAt ? formatDate(order.payment.submittedAt) : "just now"}
                          </p>
                          <p className="mt-1 text-xs text-amber-200/80">The desk will verify it. This is not yet a confirmed payment.</p>
                        </div>
                      ) : (
                        <div>
                          <Label htmlFor="upi-ref" required>Transaction reference / UTR</Label>
                          <Input
                            id="upi-ref"
                            value={reference}
                            onChange={(e) => setReference(e.target.value)}
                            placeholder="e.g. 402512345678"
                            maxLength={64}
                            autoComplete="off"
                            autoCapitalize="characters"
                            spellCheck={false}
                            aria-describedby="upi-ref-help"
                          />
                          <p id="upi-ref-help" className="text-[11px] text-zinc-500 mt-1.5">
                            4–64 letters/numbers (dots, dashes, slashes and underscores allowed). Found in your payment app&apos;s history.
                          </p>
                          {rejected && (
                            <p className="text-xs text-red-300 mt-2 break-words">
                              Previous payment was rejected{order.payment.note ? `: ${order.payment.note}` : ""}. You can submit a corrected reference.
                            </p>
                          )}
                          <FieldError message={referenceError ?? undefined} />
                          <Button className="w-full mt-3 min-h-11" onClick={submitReference} loading={payBusy} disabled={!canSubmitUpi || reference.trim().length < 4}>
                            I&apos;ve paid — submit for verification
                          </Button>
                        </div>
                      )}
                    </div>
                  )}

                  {method === "CASH_ON_DELIVERY" && !paid && (
                    <div className="flex items-start gap-3 rounded-xl border border-sky-500/30 bg-sky-500/10 p-4">
                      <Banknote className="h-5 w-5 text-sky-300 shrink-0 mt-0.5" aria-hidden="true" />
                      <div className="text-sm text-sky-100">
                        <p className="font-semibold">Pay at pickup</p>
                        <p className="text-sky-200/90 mt-0.5">
                          Bring {formatCurrencyINR(order.totalAmount)} when you collect your documents. The desk will record
                          your payment then — your order stays <strong>Payment Pending</strong> until that happens.
                        </p>
                      </div>
                    </div>
                  )}

                  {!method && (
                    <p className="text-xs text-zinc-500">Select a method above to continue. Nothing is charged automatically.</p>
                  )}
                </>
              )}

              {order.payment.reference && (
                <p className="text-[11px] text-zinc-500 break-words">
                  Submitted reference: <span className="font-mono text-zinc-300">{order.payment.reference}</span>
                </p>
              )}
            </>
          )}
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
        {order.finishingOptions.length > 0 && <Row label="Finishing" value={order.finishingOptions.join(", ")} />}
        {order.finishingFee > 0 && <Row label="Finishing fee" value={formatCurrencyINR(order.finishingFee)} />}
        <div className="border-t border-white/10 pt-3 flex justify-between items-center">
          <span className="font-bold text-white">Total</span>
          <span className="text-xl font-extrabold text-white">{formatCurrencyINR(order.totalAmount)}</span>
        </div>
        {order.payment.history.length > 0 && (
          <details className="text-xs text-zinc-400 pt-2 border-t border-white/10">
            <summary className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60">
              Payment history
            </summary>
            <ul className="mt-2 space-y-1.5">
              {order.payment.history.map((p) => (
                <li key={p.id} className="rounded-lg bg-white/[0.03] px-2.5 py-2">
                  <span className="text-white">{p.type.replaceAll("_", " ")}</span>
                  {p.reference ? <span className="font-mono text-zinc-400"> · {p.reference}</span> : null}
                  <span className="text-zinc-600"> · {formatDate(p.createdAt)}</span>
                  {p.note && <p className="text-zinc-400 break-words mt-0.5">{p.note}</p>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>

      {/* Files */}
      <Card className="space-y-3">
        <h2 className="font-bold text-white mb-1">Documents</h2>
        {order.files.map((f) => (
          <div key={f.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-white/5 pt-3 first:border-0 first:pt-0">
            <div className="flex items-center gap-3 min-w-0">
              <FileText className="h-4 w-4 text-zinc-500 shrink-0" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-sm text-white truncate">{f.originalName}</p>
                <p className="text-xs text-zinc-500">
                  {formatBytes(f.sizeBytes)} · {f.pageCount != null ? `${f.pageCount} pages` : "page count pending"}
                  {f.pageCountSource === "ADMIN_VERIFIED" ? " (admin verified)" : ""}
                  {" · "}{f.status === "COMPLETED" ? "upload verified" : f.status.toLowerCase()}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-1">
              {f.mimeType === "application/pdf" && f.status === "COMPLETED" && (
                <a
                  href={`/api/files/${f.id}/download?mode=view`}
                  target="_blank" rel="noopener noreferrer"
                  className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-zinc-400 hover:text-white hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60"
                  aria-label={`Preview ${f.originalName}`}
                >
                  <Eye className="h-4 w-4" />
                </a>
              )}
              <a
                href={`/api/files/${f.id}/download`}
                target="_blank" rel="noopener noreferrer"
                className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-zinc-400 hover:text-white hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60"
                aria-label={`Download ${f.originalName}`}
              >
                <Download className="h-4 w-4" />
              </a>
            </div>
          </div>
        ))}
        {order.files.length === 0 && <p className="text-sm text-zinc-500">No documents attached.</p>}
      </Card>

      {/* Actions */}
      <div className="flex flex-wrap gap-3">
        <a href={`/api/invoices/${order.id}`} target="_blank" rel="noopener" className="flex-1 min-w-[140px]">
          <Button variant="ghost" className="w-full min-h-11" icon={<Download className="h-4 w-4" />}>Download Invoice</Button>
        </a>
        {order.cancellation.allowed && !terminal && (
          <Button variant="danger" className="flex-1 min-w-[140px] min-h-11" onClick={() => setCancelOpen(true)} icon={<XCircle className="h-4 w-4" />}>
            Cancel order
          </Button>
        )}
        {canRate && (
          <Button className="flex-1 min-w-[140px] min-h-11" onClick={() => setFbOpen(true)} icon={<Star className="h-4 w-4" />}>
            Rate this order
          </Button>
        )}
      </div>

      {!order.cancellation.allowed && !terminal && order.cancellation.explanation && (
        <div className="flex items-start gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-xs text-zinc-400">
          <Lock className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{order.cancellation.explanation} Contact the print desk if you need help.</span>
        </div>
      )}

      {order.status === "DELIVERED" && order.feedback && (
        <Card>
          <div className="flex items-center gap-2" aria-label={`Rated ${order.feedback.rating} out of 5`}>
            {[1, 2, 3, 4, 5].map((n) => (
              <Star key={n} className={`h-4 w-4 ${n <= order.feedback!.rating ? "fill-amber-400 text-amber-400" : "text-zinc-700"}`} aria-hidden="true" />
            ))}
          </div>
          {order.feedback.comment && <p className="text-xs text-zinc-400 mt-2 break-words">{order.feedback.comment}</p>}
        </Card>
      )}

      <p className="text-[11px] text-zinc-600 flex items-center gap-1.5">
        <RefreshCw className="h-3 w-3" /> This page refreshes automatically with status changes.
      </p>

      {/* Cancel dialog */}
      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title="Cancel this order?">
        <p className="text-sm text-zinc-300 mb-4">
          Cancellation is only available before the print desk accepts the order, and this cannot be undone.
          This action does not issue an automatic refund; any payment already made is handled separately by the desk.
        </p>
        <Label htmlFor="reason">Reason (optional)</Label>
        <Textarea id="reason" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="Tell us why you're cancelling…" maxLength={300} />
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" size="md" onClick={() => setCancelOpen(false)}>Keep order</Button>
          <Button variant="danger" size="md" onClick={doCancel} loading={cancelling}>Cancel order</Button>
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
            <Textarea id="fbcomment" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="How was the print quality and service?" maxLength={1000} />
          </div>
          <FieldError message={rating === 0 ? "Please select a star rating." : undefined} />
          <Button className="w-full min-h-11" onClick={submitFeedback} loading={fbBusy} disabled={rating === 0}>
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
      <span className="text-white font-medium text-right break-words">{value}</span>
    </div>
  );
}
