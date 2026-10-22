"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card, EmptyState, ErrorState, Modal, Skeleton, Textarea, Label } from "@/components/ui";
import { PaymentStatusBadge, StatusBadge } from "@/components/status-badge";
import { useToast } from "@/components/toast";
import { api, ApiError } from "@/lib/api-client";
import { formatCurrencyINR, formatDate } from "@/lib/utils";
import { BadgeCheck, Ban, Banknote, ExternalLink } from "lucide-react";
import { paymentMethodLabel } from "@/lib/status-meta";
import { isPaymentEligibleOrderStatus } from "@/lib/order-status";

interface PaymentRow {
  id: string;
  orderNumber: string;
  student: { name: string; regNo: string | null; email: string; phone: string | null };
  amount: number;
  orderStatus: string;
  paymentMethod: string | null;
  paymentRef: string | null;
  paymentProofAt: string | null;
  paymentStatus: string;
  paymentNote: string | null;
  paymentVerifiedAt: string | null;
  createdAt: string;
}

const STATES = [
  { key: "PENDING_REVIEW", label: "Needs review" },
  { key: "AWAITING_CASH", label: "Cash at pickup" },
  { key: "CONFIRMED", label: "Confirmed" },
  { key: "REJECTED", label: "Rejected" },
];

/** Payment can be confirmed only while production is active, or after pickup for cash. */
function paymentStageOpen(orderStatus: string): boolean {
  return isPaymentEligibleOrderStatus(orderStatus) || orderStatus === "DELIVERED";
}

/**
 * Payment desk. UPI references are claims and require a human check; cash is
 * only marked received here, never by the student's method selection.
 */
export function AdminPayments() {
  const [state, setState] = useState("PENDING_REVIEW");
  const [rows, setRows] = useState<PaymentRow[] | null>(null);
  const [verifyRow, setVerifyRow] = useState<PaymentRow | null>(null);
  const [rejectRow, setRejectRow] = useState<PaymentRow | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    setRows(null);
    setError(null);
    try {
      const data = await api<{ orders: PaymentRow[] }>(`/api/admin/payments?state=${state}`);
      setRows(data.orders);
    } catch (err) {
      setRows([]);
      setError(err instanceof ApiError ? err.message : "Payments could not be loaded. Please retry.");
    }
  }, [state]);

  useEffect(() => {
    load();
  }, [load]);

  async function verify() {
    if (!verifyRow) return;
    setBusy(true);
    try {
      await api(`/api/admin/payments/${verifyRow.id}/verify`, { method: "PATCH", json: { note, confirm: true } });
      toast(
        verifyRow.paymentMethod === "CASH_ON_DELIVERY"
          ? `Cash received for ${verifyRow.orderNumber} recorded.`
          : `Payment for ${verifyRow.orderNumber} confirmed.`,
        "success"
      );
      setVerifyRow(null);
      setNote("");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Verification failed.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (!rejectRow) return;
    setBusy(true);
    try {
      await api(`/api/admin/payments/${rejectRow.id}/reject`, { method: "PATCH", json: { reason: note } });
      toast(`Payment for ${rejectRow.orderNumber} rejected. The student can resubmit.`, "success");
      setRejectRow(null);
      setNote("");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Rejection failed.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5 min-w-0">
      <div>
        <h1 className="text-2xl font-extrabold text-white tracking-tight">Payments</h1>
        <p className="text-sm text-zinc-500 mt-1">Verify UPI references and record cash collected at pickup.</p>
      </div>

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Payment states">
        {STATES.map((s) => (
          <button
            key={s.key}
            role="tab"
            aria-selected={state === s.key}
            onClick={() => setState(s.key)}
            className={`inline-flex min-h-11 items-center rounded-xl px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60 ${
              state === s.key ? "bg-[#7c5cff] text-white" : "text-zinc-400 hover:text-white hover:bg-white/5"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {rows === null ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading payments">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
        </div>
      ) : error ? (
        <Card>
          <ErrorState title="Could not load payments" sub={error} onRetry={load} />
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            title={state === "PENDING_REVIEW" ? "No payments waiting for review." : "Nothing here."}
            icon={<BadgeCheck className="h-8 w-8" />}
          />
        </Card>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.id} className="card p-4 min-w-0">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/admin/orders/${r.id}`} className="font-semibold text-white text-sm hover:text-[#b49aff]">
                      {r.orderNumber}
                    </Link>
                    <PaymentStatusBadge status={r.paymentStatus} />
                    <StatusBadge status={r.orderStatus} />
                  </div>
                  <p className="text-xs text-zinc-400 mt-1 break-words">
                    {r.student.name} · {r.student.regNo ?? r.student.email}
                  </p>
                  <p className="text-xs text-zinc-500 mt-0.5 break-words">
                    {paymentMethodLabel(r.paymentMethod)} · Ref:{" "}
                    <span className="font-mono text-zinc-300">{r.paymentRef ?? "—"}</span>
                    {r.paymentProofAt ? ` · submitted ${formatDate(r.paymentProofAt)}` : ""}
                  </p>
                  {r.paymentVerifiedAt && <p className="text-[11px] text-emerald-300 mt-0.5">Received {formatDate(r.paymentVerifiedAt)}</p>}
                  {r.paymentNote && <p className="text-[11px] text-zinc-500 mt-1 break-words">Note: {r.paymentNote}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-lg font-extrabold text-white whitespace-nowrap">{formatCurrencyINR(r.amount)}</span>
                  {(state === "PENDING_REVIEW" || state === "AWAITING_CASH") && paymentStageOpen(r.orderStatus) && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="md"
                        variant="success"
                        className="min-h-11"
                        onClick={() => { setVerifyRow(r); setNote(""); }}
                        icon={r.paymentMethod === "CASH_ON_DELIVERY" ? <Banknote className="h-4 w-4" /> : <BadgeCheck className="h-4 w-4" />}
                      >
                        {r.paymentMethod === "CASH_ON_DELIVERY" ? "Mark cash received" : "Verify"}
                      </Button>
                      {state === "PENDING_REVIEW" && r.paymentStatus !== "PAYMENT_PENDING" && (
                        <Button
                          size="md"
                          variant="danger"
                          className="min-h-11"
                          onClick={() => { setRejectRow(r); setNote(""); }}
                          icon={<Ban className="h-4 w-4" />}
                        >
                          Reject
                        </Button>
                      )}
                    </div>
                  )}
                  <Link
                    href={`/admin/orders/${r.id}`}
                    className="inline-flex min-h-11 items-center gap-1 rounded-xl px-2 text-xs text-zinc-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60"
                    aria-label={`Open order ${r.orderNumber}`}
                  >
                    <ExternalLink className="h-4 w-4" /> Order
                  </Link>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Verify dialog */}
      <Modal open={!!verifyRow} onClose={() => setVerifyRow(null)} title={`Confirm payment — ${verifyRow?.orderNumber ?? ""}`}>
        <p className="text-sm text-zinc-300 mb-4">
          Confirm that <span className="font-bold text-white">{formatCurrencyINR(verifyRow?.amount ?? 0)}</span> was actually received
          {verifyRow?.paymentRef ? <> for reference <span className="font-mono break-all">{verifyRow.paymentRef}</span></> : null}.
        </p>
        <Label htmlFor="vnote">Verification note (optional)</Label>
        <Textarea
          id="vnote"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Verified against bank statement"
          maxLength={500}
        />
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" size="md" onClick={() => setVerifyRow(null)}>Cancel</Button>
          <Button variant="success" size="md" onClick={verify} loading={busy}>
            {verifyRow?.paymentMethod === "CASH_ON_DELIVERY" ? "Record cash received" : "Confirm payment"}
          </Button>
        </div>
      </Modal>

      {/* Reject dialog */}
      <Modal open={!!rejectRow} onClose={() => setRejectRow(null)} title={`Reject payment — ${rejectRow?.orderNumber ?? ""}`}>
        <p className="text-sm text-zinc-300 mb-4">
          The student will be notified and can resubmit a corrected reference. A reason is required and kept in the audit history.
        </p>
        <Label htmlFor="rnote" required>Rejection reason</Label>
        <Textarea
          id="rnote"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Reference not found in statement"
          maxLength={500}
        />
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" size="md" onClick={() => setRejectRow(null)}>Cancel</Button>
          <Button variant="danger" size="md" onClick={reject} loading={busy} disabled={note.trim().length < 3}>Reject payment</Button>
        </div>
      </Modal>
    </div>
  );
}
