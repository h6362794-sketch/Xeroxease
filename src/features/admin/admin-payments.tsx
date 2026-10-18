"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, EmptyState, Modal, Skeleton, Textarea, Label } from "@/components/ui";
import { PaymentStatusBadge } from "@/components/status-badge";
import { useToast } from "@/components/toast";
import { api, ApiError } from "@/lib/api-client";
import { formatCurrencyINR, formatDate } from "@/lib/utils";
import { BadgeCheck, Ban } from "lucide-react";

interface PaymentRow {
  id: string;
  orderNumber: string;
  student: { name: string; regNo: string | null; email: string; phone: string | null };
  amount: number;
  paymentRef: string | null;
  paymentProofAt: string | null;
  paymentStatus: string;
  paymentNote: string | null;
  createdAt: string;
}

const STATES = [
  { key: "PENDING_REVIEW", label: "Needs review" },
  { key: "CONFIRMED", label: "Confirmed" },
  { key: "REJECTED", label: "Rejected" },
];

export function AdminPayments() {
  const [state, setState] = useState("PENDING_REVIEW");
  const [rows, setRows] = useState<PaymentRow[] | null>(null);
  const [verifyRow, setVerifyRow] = useState<PaymentRow | null>(null);
  const [rejectRow, setRejectRow] = useState<PaymentRow | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    setRows(null);
    try {
      const data = await api<{ orders: PaymentRow[] }>(`/api/admin/payments?state=${state}`);
      setRows(data.orders);
    } catch {
      setRows([]);
    }
  }, [state]);

  useEffect(() => {
    load();
  }, [load]);

  async function verify() {
    if (!verifyRow) return;
    setBusy(true);
    try {
      await api(`/api/admin/payments/${verifyRow.id}/verify`, { method: "PATCH", json: { note } });
      toast(`Payment for ${verifyRow.orderNumber} confirmed.`, "success");
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
      await api(`/api/admin/payments/${rejectRow.id}/reject`, { method: "PATCH", json: { note } });
      toast(`Payment for ${rejectRow.orderNumber} rejected.`, "success");
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
    <div className="space-y-5">
      <h1 className="text-2xl font-extrabold text-white tracking-tight">Payments</h1>

      <div className="flex gap-2">
        {STATES.map((s) => (
          <button
            key={s.key}
            onClick={() => setState(s.key)}
            className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60 ${
              state === s.key ? "bg-[#7c5cff] text-white" : "text-zinc-400 hover:text-white hover:bg-white/5"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {rows === null ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 rounded-xl" />)}</div>
      ) : rows.length === 0 ? (
        <Card><EmptyState title={state === "PENDING_REVIEW" ? "No payments waiting for review." : "Nothing here."} icon={<BadgeCheck className="h-8 w-8" />} /></Card>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.id} className="card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-white text-sm">{r.orderNumber}</p>
                    <PaymentStatusBadge status={r.paymentStatus} />
                  </div>
                  <p className="text-xs text-zinc-400 mt-1">
                    {r.student.name} · {r.student.regNo ?? r.student.email}
                  </p>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    Ref: <span className="font-mono text-zinc-300">{r.paymentRef ?? "—"}</span>
                    {r.paymentProofAt ? ` · submitted ${formatDate(r.paymentProofAt)}` : ""}
                  </p>
                  {r.paymentNote && <p className="text-[11px] text-zinc-500 mt-1">Note: {r.paymentNote}</p>}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-lg font-extrabold text-white">{formatCurrencyINR(r.amount)}</span>
                  {state === "PENDING_REVIEW" && (
                    <div className="flex gap-2">
                      <Button size="sm" variant="success" onClick={() => { setVerifyRow(r); setNote(""); }} icon={<BadgeCheck className="h-4 w-4" />}>
                        Verify
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => { setRejectRow(r); setNote(""); }} icon={<Ban className="h-4 w-4" />}>
                        Reject
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Verify dialog */}
      <Modal open={!!verifyRow} onClose={() => setVerifyRow(null)} title={`Verify payment — ${verifyRow?.orderNumber ?? ""}`}>
        <p className="text-sm text-zinc-300 mb-4">
          Confirm that <span className="font-bold text-white">{formatCurrencyINR(verifyRow?.amount ?? 0)}</span> was received
          for reference <span className="font-mono">{verifyRow?.paymentRef ?? "—"}</span>.
        </p>
        <Label htmlFor="vnote" required>Verification note</Label>
        <Textarea id="vnote" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Verified against bank statement" />
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setVerifyRow(null)}>Cancel</Button>
          <Button variant="success" size="sm" onClick={verify} loading={busy} disabled={note.trim().length < 3}>Confirm payment</Button>
        </div>
      </Modal>

      {/* Reject dialog */}
      <Modal open={!!rejectRow} onClose={() => setRejectRow(null)} title={`Reject payment — ${rejectRow?.orderNumber ?? ""}`}>
        <p className="text-sm text-zinc-300 mb-4">
          The student will be notified and can resubmit. A note is required.
        </p>
        <Label htmlFor="rnote" required>Rejection reason</Label>
        <Textarea id="rnote" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Reference not found in statement" />
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setRejectRow(null)}>Cancel</Button>
          <Button variant="danger" size="sm" onClick={reject} loading={busy} disabled={note.trim().length < 3}>Reject payment</Button>
        </div>
      </Modal>
    </div>
  );
}
