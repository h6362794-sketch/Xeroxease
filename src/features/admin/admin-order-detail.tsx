"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft, BadgeCheck, Ban, CheckCircle2, Download, Eye, FileText,
  History, IndianRupee, Phone, Printer, RefreshCw, ShieldCheck, Truck, XCircle,
} from "lucide-react";
import { Button, Card, EmptyState, FieldError, Input, Label, Modal, Select, Skeleton, Textarea } from "@/components/ui";
import { StatusBadge, PaymentStatusBadge } from "@/components/status-badge";
import { useToast } from "@/components/toast";
import { api, ApiError } from "@/lib/api-client";
import { formatBytes, formatCurrencyINR, formatDate, timeAgo } from "@/lib/utils";
import { statusLabel } from "@/lib/order-status";
import { paymentMethodLabel } from "@/lib/status-meta";
import { canAdminRejectPayment, canAdminVerifyPayment } from "@/lib/payment-policy";

interface OrderFile {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
  pageCount: number | null;
  pageCountSource: string | null;
  analysisStatus: string;
  analysisError: string | null;
  analyzedAt: string | null;
  createdAt: string;
  pageCountVerified: boolean;
}

interface StatusEvent {
  id: string;
  type: string;
  fromStatus: string | null;
  toStatus: string | null;
  message: string | null;
  actorId: string | null;
  actorRole: string | null;
  actorName: string | null;
  createdAt: string;
}

interface PaymentEventRow {
  id: string;
  type: string;
  amount: number | null;
  reference: string | null;
  note: string | null;
  actorRole: string | null;
  actor: { id: string; name: string } | null;
  createdAt: string;
}

interface Detail {
  id: string;
  orderNumber: string;
  status: string;
  statusLabel: string;
  statusHistory: StatusEvent[];
  allowedNextStatuses: string[];
  stageIndex: number;
  cancellationExplanation: string | null;
  createdAt: string;
  updatedAt: string;
  acceptedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  deliveredAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  adminNotes: string | null;
  totalAmount: number;
  pricePerPage: number;
  finishingFee: number;
  pricingSnapshot: unknown;
  finishingOptions: string[];
  totalPages: number;
  billablePages: number;
  paperSize: string;
  colorMode: string;
  sides: string;
  copies: number;
  pageSelection: string;
  customPages: string | null;
  student: { id: string; name: string; email: string; regNo: string | null; phone: string | null; branch: string | null; section: string | null; year: number | null };
  files: OrderFile[];
  payment: {
    method: string | null;
    status: string;
    reference: string | null;
    submittedAt: string | null;
    verifiedBy: string | null;
    verifiedAt: string | null;
    note: string | null;
    history: PaymentEventRow[];
  };
  feedback: { id: string; rating: number; comment: string | null; createdAt: string } | null;
}

function fileUrl(orderId: string, fileId: string, mode: "view" | "download") {
  return `/api/admin/orders/${orderId}/files/${fileId}/download?mode=${mode}`;
}

export function AdminOrderDetail({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const [nextStatus, setNextStatus] = useState("");
  const [note, setNote] = useState("");
  const [confirmTarget, setConfirmTarget] = useState<string | null>(null);
  const [paymentAction, setPaymentAction] = useState<"verify" | "reject" | null>(null);
  const [paymentNote, setPaymentNote] = useState("");
  const [pageCountDrafts, setPageCountDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ order: Detail }>(`/api/admin/orders/${orderId}`);
      setOrder(data.order);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Order could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    load();
  }, [load]);

  async function applyStatus(target: string, reason: string, confirm: boolean) {
    setBusy(true);
    try {
      await api(`/api/admin/orders/${orderId}/status`, {
        method: "PATCH",
        json: { status: target, note: reason, confirm },
      });
      toast(`Order moved to ${statusLabel(target)}.`, "success");
      setNextStatus("");
      setNote("");
      setConfirmTarget(null);
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Status update failed.", "error");
    } finally {
      setBusy(false);
    }
  }

  function requestStatus(target: string) {
    if (!target) return;
    if (target === "REJECTED" && note.trim().length < 3) {
      toast("Enter a reason (at least 3 characters) before rejecting the order.", "error");
      return;
    }
    if (target === "DELIVERED" || target === "REJECTED") {
      setConfirmTarget(target);
      return;
    }
    applyStatus(target, note, false);
  }

  async function decidePayment(action: "verify" | "reject") {
    if (!order) return;
    setBusy(true);
    try {
      if (action === "reject") {
        await api(`/api/admin/payments/${order.id}/reject`, {
          method: "PATCH",
          json: { reason: paymentNote },
        });
        toast("Payment rejected. The student can resubmit.", "success");
      } else {
        await api(`/api/admin/payments/${order.id}/verify`, {
          method: "PATCH",
          json: { note: paymentNote, confirm: true },
        });
        toast("Payment marked as received.", "success");
      }
      setPaymentAction(null);
      setPaymentNote("");
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Payment update failed.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function correctPageCount(fileId: string) {
    if (!order) return;
    const value = Number(pageCountDrafts[fileId]);
    if (!Number.isInteger(value) || value < 1 || value > 10000) {
      toast("Enter a whole page count between 1 and 10000.", "error");
      return;
    }
    setBusy(true);
    try {
      await api(`/api/admin/orders/${order.id}/files/${fileId}/pagecount`, {
        method: "PATCH",
        json: { fileId, pageCount: value },
      });
      toast("Page count corrected (audited).", "success");
      setPageCountDrafts((d) => ({ ...d, [fileId]: "" }));
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Correction failed.", "error");
    } finally {
      setBusy(false);
    }
  }

  if (loading && !order) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading order">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-36 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }

  if (error || !order) {
    return (
      <div className="max-w-2xl mx-auto">
        <Link href="/admin/orders" className="inline-flex min-h-11 items-center gap-2 text-sm text-zinc-400 hover:text-white">
          <ArrowLeft className="h-4 w-4" /> Back to orders
        </Link>
        <Card>
          <EmptyState
            title="Order unavailable"
            sub={error ?? "This order could not be found."}
            icon={<XCircle className="h-8 w-8" />}
          />
        </Card>
      </div>
    );
  }

  const options = order.allowedNextStatuses ?? [];
  const canQuickDeliver = options.includes("DELIVERED");
  // Use the same policy the API enforces, so a button can never be shown for a
  // decision the server would reject (e.g. confirming money on a rejected order).
  const paymentContext = {
    orderStatus: order.status,
    paymentStatus: order.payment.status,
    paymentMethod: order.payment.method,
    paymentRef: order.payment.reference,
  };
  const canVerifyPayment = canAdminVerifyPayment(paymentContext).ok;
  const canRejectPayment = canAdminRejectPayment({
    paymentStatus: order.payment.status,
    reason: "pending",
  }).ok;

  return (
    <div className="space-y-5 min-w-0 max-w-6xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href="/admin/orders" className="inline-flex min-h-11 items-center gap-2 text-sm text-zinc-400 hover:text-white">
            <ArrowLeft className="h-4 w-4" /> Back to orders
          </Link>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight break-words">{order.orderNumber}</h1>
          <p className="text-xs text-zinc-500 mt-1">
            Placed {formatDate(order.createdAt)} · last updated {timeAgo(order.updatedAt)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={order.status} />
          <PaymentStatusBadge status={order.payment.status} />
          <Button variant="ghost" size="sm" onClick={load} loading={loading} icon={<RefreshCw className="h-4 w-4" />}>
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2 min-w-0">
          <Card className="space-y-4">
            <h2 className="font-bold text-white flex items-center gap-2"><FileText className="h-4 w-4 text-[#b49aff]" /> Student</h2>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <Detail label="Name" value={order.student.name} />
              <Detail label="Registration no." value={order.student.regNo ?? "—"} />
              <Detail label="Email" value={order.student.email} />
              <Detail label="Phone" value={order.student.phone ?? "—"} />
              <Detail label="Branch / section" value={`${order.student.branch ?? "—"} ${order.student.section ?? ""}`} />
              <Detail label="Year" value={order.student.year ? String(order.student.year) : "—"} />
            </dl>
            {order.student.phone && (
              <a
                href={`tel:${order.student.phone.replace(/[^0-9+]/g, "")}`}
                className="inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-[#b49aff] hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60"
                aria-label={`Call ${order.student.name} at ${order.student.phone}`}
              >
                <Phone className="h-4 w-4" /> Call student
              </a>
            )}
          </Card>

          <Card className="space-y-4">
            <h2 className="font-bold text-white flex items-center gap-2"><Printer className="h-4 w-4 text-[#b49aff]" /> Print configuration & pricing</h2>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <Detail label="Paper" value={order.paperSize} />
              <Detail label="Colour" value={order.colorMode === "COLOR" ? "Colour" : "Black & white"} />
              <Detail label="Sides" value={order.sides === "DOUBLE" ? "Double-sided" : "Single-sided"} />
              <Detail label="Copies" value={String(order.copies)} />
              <Detail label="Pages" value={order.pageSelection === "CUSTOM" ? `Custom — ${order.customPages ?? "—"}` : "All pages"} />
              <Detail label="Verified pages / billable" value={`${order.totalPages} / ${order.billablePages}`} />
              <Detail label="Finishing" value={order.finishingOptions.length ? order.finishingOptions.join(", ") : "None"} />
              <Detail label="Rate" value={`${formatCurrencyINR(order.pricePerPage)} / page`} />
            </dl>
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-1 text-sm">
              <div className="flex justify-between gap-4 text-zinc-400">
                <span>Print cost</span>
                <span className="text-white">{formatCurrencyINR(order.billablePages * order.pricePerPage)}</span>
              </div>
              <div className="flex justify-between gap-4 text-zinc-400">
                <span>Finishing</span>
                <span className="text-white">{formatCurrencyINR(order.finishingFee)}</span>
              </div>
              <div className="flex justify-between gap-4 border-t border-white/10 pt-2 font-bold text-white">
                <span>Total (locked at order time)</span>
                <span>{formatCurrencyINR(order.totalAmount)}</span>
              </div>
            </div>
            {order.pricingSnapshot != null && (
              <details className="text-xs text-zinc-400">
                <summary className="cursor-pointer select-none rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60">
                  Pricing snapshot recorded with this order
                </summary>
                <pre className="mt-2 max-h-52 overflow-auto rounded-xl bg-black/40 p-3 text-[11px] leading-relaxed">
                  {JSON.stringify(order.pricingSnapshot, null, 2)}
                </pre>
              </details>
            )}
          </Card>

          <Card className="space-y-3">
            <h2 className="font-bold text-white">Documents ({order.files.length})</h2>
            {order.files.length === 0 ? (
              <p className="text-sm text-zinc-500">No documents are attached to this order.</p>
            ) : (
              <ul className="space-y-3">
                {order.files.map((f) => (
                  <li key={f.id} className="rounded-xl border border-white/10 p-3 space-y-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm text-white font-medium break-all">{f.originalName}</p>
                        <p className="text-[11px] text-zinc-500 mt-0.5">
                          {f.mimeType} · {formatBytes(f.sizeBytes)} · upload {f.status.toLowerCase()}
                        </p>
                        <p className="text-[11px] text-zinc-500 mt-0.5">
                          {f.pageCount != null ? (
                            <>Pages: <span className="text-white font-semibold">{f.pageCount}</span>
                              {f.pageCountSource ? ` (${f.pageCountSource.replaceAll("_", " ").toLowerCase()})` : ""}</>
                          ) : (
                            <span className="text-amber-400">{f.analysisError ?? "Page count not available."}</span>
                          )}
                          {f.status !== "COMPLETED" && <span className="text-red-400"> · not verified for download</span>}
                        </p>
                        <p className="text-[10px] text-zinc-600 mt-0.5 break-all">Document ID: {f.id}</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <a
                          href={fileUrl(order.id, f.id, "view")}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-white/15 px-3 text-xs font-semibold text-white hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60"
                          aria-label={`Preview ${f.originalName}`}
                        >
                          <Eye className="h-4 w-4" aria-hidden="true" /> Preview
                        </a>
                        <a
                          href={fileUrl(order.id, f.id, "download")}
                          className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-[#7c5cff] px-3 text-xs font-semibold text-white hover:bg-[#6d4aff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60"
                          aria-label={`Download ${f.originalName}`}
                        >
                          <Download className="h-4 w-4" aria-hidden="true" /> Download
                        </a>
                      </div>
                    </div>
                    {(!f.pageCountVerified || f.pageCount == null) && (
                      <div className="flex flex-wrap items-end gap-2">
                        <div className="min-w-[10rem] flex-1">
                          <Label htmlFor={`pc-${f.id}`}>Correct verified page count</Label>
                          <Input
                            id={`pc-${f.id}`}
                            type="number"
                            min={1}
                            max={10000}
                            inputMode="numeric"
                            placeholder={f.pageCount != null ? String(f.pageCount) : "e.g. 24"}
                            value={pageCountDrafts[f.id] ?? ""}
                            onChange={(e) => setPageCountDrafts((d) => ({ ...d, [f.id]: e.target.value }))}
                          />
                        </div>
                        <Button size="md" onClick={() => correctPageCount(f.id)} loading={busy} disabled={!pageCountDrafts[f.id]}>
                          Save page count
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[11px] text-zinc-500 flex items-center gap-1.5">
              <ShieldCheck className="h-3 w-3 text-emerald-400" /> Downloads are authorized per order; the storage bucket stays private.
            </p>
          </Card>

          <Card className="space-y-3">
            <h2 className="font-bold text-white flex items-center gap-2"><History className="h-4 w-4 text-[#b49aff]" /> Status & audit history</h2>
            {order.statusHistory.length === 0 ? (
              <p className="text-sm text-zinc-500">No history recorded yet.</p>
            ) : (
              <ol className="space-y-2">
                {order.statusHistory.map((e) => (
                  <li key={e.id} className="rounded-xl bg-white/[0.03] px-3 py-2 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-white">
                        {e.type === "STATUS_CHANGE" && e.fromStatus && e.toStatus
                          ? `${statusLabel(e.fromStatus)} → ${statusLabel(e.toStatus)}`
                          : e.type.replaceAll("_", " ")}
                      </span>
                      <time className="text-zinc-500" dateTime={e.createdAt}>{formatDate(e.createdAt)}</time>
                    </div>
                    {e.message && <p className="text-zinc-400 mt-1 break-words">{e.message}</p>}
                    <p className="text-[10px] text-zinc-600 mt-0.5">
                      {e.actorName ?? (e.actorRole ? e.actorRole.toLowerCase() : "system")}
                    </p>
                  </li>
                ))}
              </ol>
            )}
            {order.feedback && (
              <p className="text-xs text-zinc-400 border-t border-white/10 pt-2">
                Feedback: {order.feedback.rating}/5 {order.feedback.comment ? `— ${order.feedback.comment}` : ""}
              </p>
            )}
          </Card>
        </div>

        <div className="space-y-5 min-w-0">
          <Card className="space-y-3">
            <h2 className="font-bold text-white">Update status</h2>
            {options.length === 0 ? (
              <p className="text-sm text-zinc-500">This order is in a final state. No further status changes are allowed.</p>
            ) : (
              <>
                <div>
                  <Label htmlFor="next-status">Next status</Label>
                  <Select id="next-status" value={nextStatus} onChange={(e) => setNextStatus(e.target.value)}>
                    <option value="">Select a valid next status…</option>
                    {options.map((s) => {
                      const destructive = s === "REJECTED" || s === "CANCELLED" || s === "FAILED";
                      return <option key={s} value={s}>{destructive ? `${statusLabel(s)} (closes order)` : statusLabel(s)}</option>;
                    })}
                  </Select>
                </div>
                <div>
                  <Label htmlFor="status-note">
                    Note {nextStatus === "REJECTED" && <span className="text-red-400">(reason required)</span>}
                  </Label>
                  <Textarea
                    id="status-note"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={500}
                    placeholder={nextStatus === "REJECTED" ? "Why is this order not accepted?" : "Optional note shown in history"}
                  />
                </div>
                <FieldError message={nextStatus === "REJECTED" && note.trim().length > 0 && note.trim().length < 3 ? "Reason must be at least 3 characters." : undefined} />
                <Button className="w-full min-h-11" onClick={() => requestStatus(nextStatus)} disabled={!nextStatus} loading={busy}>
                  Apply status change
                </Button>
                {canQuickDeliver && (
                  <Button className="w-full min-h-11" variant="success" onClick={() => { setNextStatus("DELIVERED"); setConfirmTarget("DELIVERED"); }} icon={<Truck className="h-4 w-4" />}>
                    Mark as Delivered
                  </Button>
                )}
                <p className="text-[11px] text-zinc-500">
                  Only transitions allowed by the server are listed. Delivery and rejection require confirmation.
                </p>
              </>
            )}
          </Card>

          <Card className="space-y-3">
            <h2 className="font-bold text-white">Payment</h2>
            <dl className="space-y-2 text-sm">
              <Detail label="Method" value={paymentMethodLabel(order.payment.method)} />
              <Detail label="Status" value={<PaymentStatusBadge status={order.payment.status} />} />
              <Detail label="Amount due" value={formatCurrencyINR(order.totalAmount)} />
              {order.payment.reference && <Detail label="Reference" value={<span className="font-mono break-all text-white">{order.payment.reference}</span>} />}
              {order.payment.submittedAt && <Detail label="Submitted" value={formatDate(order.payment.submittedAt)} />}
              {order.payment.verifiedAt && <Detail label="Verified" value={formatDate(order.payment.verifiedAt)} />}
              {order.payment.note && <Detail label="Note" value={<span className="break-words">{order.payment.note}</span>} />}
            </dl>
            {canVerifyPayment && (
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  size="md"
                  variant="success"
                  className="min-h-11"
                  onClick={() => { setPaymentAction("verify"); setPaymentNote(""); }}
                  icon={<BadgeCheck className="h-4 w-4" />}
                >
                  {order.payment.method === "CASH_ON_DELIVERY" ? "Mark cash received" : "Confirm payment"}
                </Button>
                {canRejectPayment && (
                  <Button
                    size="md"
                    variant="danger"
                    className="min-h-11"
                    onClick={() => { setPaymentAction("reject"); setPaymentNote(""); }}
                    icon={<Ban className="h-4 w-4" />}
                  >
                    Reject
                  </Button>
                )}
              </div>
            )}
            {order.payment.status === "PAYMENT_CONFIRMED" && (
              <p className="text-xs text-emerald-300 flex items-center gap-1.5">
                <CheckCircle2 className="h-4 w-4" /> Payment recorded. The order lifecycle is unchanged.
              </p>
            )}
            {order.payment.history.length > 0 && (
              <details className="text-xs text-zinc-400">
                <summary className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60">
                  Payment history ({order.payment.history.length})
                </summary>
                <ul className="mt-2 space-y-2">
                  {order.payment.history.map((p) => (
                    <li key={p.id} className="rounded-lg bg-white/[0.03] p-2">
                      <p className="text-white">{p.type.replaceAll("_", " ")}{p.amount != null ? ` · ${formatCurrencyINR(p.amount)}` : ""}</p>
                      {p.reference && <p className="font-mono break-all text-zinc-400">{p.reference}</p>}
                      {p.note && <p className="text-zinc-400 break-words">{p.note}</p>}
                      <p className="text-[10px] text-zinc-600">{formatDate(p.createdAt)} · {p.actor?.name ?? p.actorRole ?? "system"}</p>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </Card>

          {(order.rejectionReason || order.cancelReason || order.cancellationExplanation) && (
            <Card className="space-y-2">
              <h2 className="font-bold text-white">Closure details</h2>
              {order.rejectionReason && <Detail label="Rejection reason" value={order.rejectionReason} />}
              {order.cancelReason && <Detail label="Cancellation reason" value={order.cancelReason} />}
              {order.cancellationExplanation && <p className="text-xs text-zinc-400">{order.cancellationExplanation}</p>}
              {order.rejectedAt && <Detail label="Rejected at" value={formatDate(order.rejectedAt)} />}
              {order.cancelledAt && <Detail label="Cancelled at" value={formatDate(order.cancelledAt)} />}
            </Card>
          )}

          <Card className="space-y-2">
            <h2 className="font-bold text-white">Invoice</h2>
            <Link
              href={`/api/invoices/${order.id}`}
              target="_blank"
              rel="noopener"
              className="inline-flex min-h-11 items-center gap-2 text-sm text-[#b49aff] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60"
            >
              <Download className="h-4 w-4" /> Open invoice
            </Link>
            <p className="text-[11px] text-zinc-500 flex items-center gap-1.5"><IndianRupee className="h-3 w-3" /> Amounts are the server-calculated figures stored with this order.</p>
          </Card>
        </div>
      </div>

      {/* Status confirmation */}
      <Modal
        open={!!confirmTarget}
        onClose={() => setConfirmTarget(null)}
        title={confirmTarget === "DELIVERED" ? "Confirm delivery" : "Confirm rejection"}
      >
        <p className="text-sm text-zinc-300">
          {confirmTarget === "DELIVERED"
            ? "Confirm that the printed documents were handed to the student. This completes the order and is recorded against your admin account."
            : "This will close the order as Not Accepted. The reason will be visible to the student and retained in history."}
        </p>
        {confirmTarget === "REJECTED" && note && <p className="mt-3 text-sm text-red-200 break-words">Reason: {note}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="md" onClick={() => setConfirmTarget(null)}>Cancel</Button>
          <Button
            variant={confirmTarget === "DELIVERED" ? "success" : "danger"}
            size="md"
            loading={busy}
            onClick={() => confirmTarget && applyStatus(confirmTarget, note, true)}
          >
            {confirmTarget === "DELIVERED" ? "Yes, mark delivered" : "Yes, reject order"}
          </Button>
        </div>
      </Modal>

      {/* Payment verify/reject dialogs */}
      <Modal
        open={!!paymentAction}
        onClose={() => setPaymentAction(null)}
        title={paymentAction === "verify" ? "Confirm payment received" : "Reject payment"}
      >
        <p className="text-sm text-zinc-300">
          {paymentAction === "verify"
            ? `Confirm that ${formatCurrencyINR(order.totalAmount)} has actually been received for ${order.orderNumber}. This is recorded against your admin account.`
            : "Explain why the submitted payment could not be verified. The student can submit a corrected reference."}
        </p>
        {paymentAction === "verify" && (
          <p className="mt-2 text-xs text-zinc-500">
            Method: {paymentMethodLabel(order.payment.method)}
            {order.payment.reference ? ` · Reference ${order.payment.reference}` : ""}
          </p>
        )}
        <div className="mt-4">
          <Label htmlFor="payment-note" required={paymentAction === "reject"}>
            {paymentAction === "verify" ? "Verification note (optional)" : "Rejection reason"}
          </Label>
          <Textarea
            id="payment-note"
            value={paymentNote}
            onChange={(e) => setPaymentNote(e.target.value)}
            placeholder={paymentAction === "verify" ? "e.g. Verified against bank statement" : "e.g. Reference not found in statement"}
            maxLength={500}
          />
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="md" onClick={() => setPaymentAction(null)}>Cancel</Button>
          <Button
            variant={paymentAction === "verify" ? "success" : "danger"}
            size="md"
            loading={busy}
            disabled={paymentAction === "reject" && paymentNote.trim().length < 3}
            onClick={() => paymentAction && decidePayment(paymentAction)}
          >
            {paymentAction === "verify" ? "Confirm received" : "Reject payment"}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <dt className="text-zinc-500">{label}</dt>
      <dd className="text-white font-medium text-right break-words max-w-full">{value}</dd>
    </div>
  );
}
