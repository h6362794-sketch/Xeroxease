"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Button, Card, EmptyState, Input, Modal, Select, Skeleton, Label, FieldError,
} from "@/components/ui";
import { StatusBadge, PaymentStatusBadge } from "@/components/status-badge";
import { useToast } from "@/components/toast";
import { api, ApiError } from "@/lib/api-client";
import { formatCurrencyINR, formatDateShort, formatBytes } from "@/lib/utils";
import { Search, Eye, Printer } from "lucide-react";

interface AdminOrder {
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
  totalAmount: number;
  paymentRef: string | null;
  createdAt: string;
  user: { name: string; email: string; regNo: string | null; phone: string | null; branch: string | null; section: string | null; year: number | null };
  _count: { files: number };
}

const NEXT_STATUS_OPTIONS: Record<string, string[]> = {
  ORDER_PLACED: ["PAYMENT_PENDING", "PAYMENT_UNDER_REVIEW", "PAYMENT_CONFIRMED", "CANCELLED", "FAILED"],
  PAYMENT_PENDING: ["PAYMENT_UNDER_REVIEW", "PAYMENT_CONFIRMED", "CANCELLED", "FAILED"],
  PAYMENT_UNDER_REVIEW: ["PAYMENT_CONFIRMED", "PAYMENT_PENDING", "CANCELLED", "FAILED"],
  PAYMENT_CONFIRMED: ["DOCUMENTS_RECEIVED", "PROCESSING", "PRINTING", "CANCELLED", "FAILED"],
  DOCUMENTS_RECEIVED: ["PROCESSING", "PRINTING", "CANCELLED", "FAILED"],
  PROCESSING: ["PRINTING", "QUALITY_CHECK", "CANCELLED", "FAILED"],
  PRINTING: ["QUALITY_CHECK", "READY_FOR_COLLECTION", "FAILED"],
  QUALITY_CHECK: ["READY_FOR_COLLECTION", "FAILED"],
  READY_FOR_COLLECTION: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  CANCELLED: [],
  FAILED: [],
};

export function AdminOrdersTable() {
  const [orders, setOrders] = useState<AdminOrder[] | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("ALL");
  const [paymentStatus, setPaymentStatus] = useState("ALL");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<AdminOrder | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    setOrders(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "15" });
      if (q.trim()) params.set("q", q.trim());
      if (status !== "ALL") params.set("status", status);
      if (paymentStatus !== "ALL") params.set("paymentStatus", paymentStatus);
      const data = await api<{ orders: AdminOrder[]; total: number }>(`/api/admin/orders?${params}`);
      setOrders(data.orders);
      setTotal(data.total);
    } catch {
      setOrders([]);
    }
  }, [q, status, paymentStatus, page]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const pages = Math.max(1, Math.ceil(total / 15));

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-extrabold text-white tracking-tight">Orders</h1>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
          <Input className="pl-10" placeholder="Order no, name, reg no, phone…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} aria-label="Search orders" />
        </div>
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Status filter">
          <option value="ALL">All statuses</option>
          {Object.keys(NEXT_STATUS_OPTIONS).map((s) => <option key={s} value={s}>{s.replaceAll("_", " ")}</option>)}
        </Select>
        <Select value={paymentStatus} onChange={(e) => { setPaymentStatus(e.target.value); setPage(1); }} aria-label="Payment filter">
          <option value="ALL">All payments</option>
          <option value="PAYMENT_PENDING">Pending</option>
          <option value="PAYMENT_UNDER_REVIEW">Under review</option>
          <option value="PAYMENT_CONFIRMED">Confirmed</option>
          <option value="PAYMENT_REJECTED">Rejected</option>
        </Select>
      </div>

      {orders === null ? (
        <div className="space-y-3">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-16 rounded-xl" />)}</div>
      ) : orders.length === 0 ? (
        <Card><EmptyState title="No orders match your filters." /></Card>
      ) : (
        <Card className="p-0 overflow-x-auto">
          <table className="w-full text-sm min-w-[760px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-zinc-500 border-b border-white/10">
                <th className="px-4 py-3">Order</th>
                <th className="px-4 py-3">Student</th>
                <th className="px-4 py-3">Config</th>
                <th className="px-4 py-3">Amount</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-b border-white/5 hover:bg-white/[0.03] transition-colors">
                  <td className="px-4 py-3">
                    <p className="font-semibold text-white">{o.orderNumber}</p>
                    <p className="text-[11px] text-zinc-500">{formatDateShort(o.createdAt)}</p>
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-white text-xs font-medium">{o.user.name}</p>
                    <p className="text-[11px] text-zinc-500">{o.user.regNo ?? o.user.email}</p>
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-400">
                    {o.paperSize} · {o.colorMode === "COLOR" ? "Color" : "B&W"} · ×{o.copies}
                    <br />
                    <span className="text-zinc-500">{o.totalPages} pages · {o._count.files} file(s)</span>
                  </td>
                  <td className="px-4 py-3 font-bold text-white whitespace-nowrap">{formatCurrencyINR(o.totalAmount)}</td>
                  <td className="px-4 py-3">
                    <div className="space-y-1.5">
                      <StatusBadge status={o.status} />
                      <PaymentStatusBadge status={o.paymentStatus} />
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button size="sm" variant="ghost" onClick={() => setSelected(o)} icon={<Eye className="h-3.5 w-3.5" />}>
                      Manage
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span className="text-xs text-zinc-500">Page {page} of {pages} · {total} orders</span>
          <Button variant="ghost" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      )}

      {selected && (
        <OrderManageModal
          order={selected}
          onClose={() => setSelected(null)}
          onChanged={() => { setSelected(null); load(); }}
        />
      )}
    </div>
  );
}

function OrderManageModal({ order, onClose, onChanged }: { order: AdminOrder; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [detail, setDetail] = useState<{
    files: { id: string; originalName: string; sizeBytes: number; pageCount: number | null; pageCountSource: string | null; analysisStatus: string; analysisError: string | null }[];
  } | null>(null);
  const [nextStatus, setNextStatus] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [corrections, setCorrections] = useState<Record<string, string>>({});

  const options = NEXT_STATUS_OPTIONS[order.status] ?? [];

  useEffect(() => {
    api<{ order: { files: NonNullable<typeof detail>["files"] } }>(`/api/orders/${order.id}`)
      .then((d) => setDetail(d.order))
      .catch(() => setDetail({ files: [] }));
  }, [order.id]);

  async function updateStatus() {
    if (!nextStatus) return;
    setBusy(true);
    try {
      await api(`/api/admin/orders/${order.id}/status`, { method: "PATCH", json: { status: nextStatus, note } });
      toast(`Order moved to ${nextStatus.replaceAll("_", " ").toLowerCase()}.`, "success");
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Status update failed.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function correctPageCount(fileId: string) {
    const value = corrections[fileId];
    if (!value || Number(value) < 1) {
      toast("Enter a valid page count.", "error");
      return;
    }
    setBusy(true);
    try {
      await api(`/api/admin/orders/${order.id}/files/${fileId}/pagecount`, {
        method: "PATCH",
        json: { fileId, pageCount: Number(value) },
      });
      toast("Page count corrected (audited).", "success");
      const d = await api<{ order: { files: NonNullable<typeof detail>["files"] } }>(`/api/orders/${order.id}`);
      setDetail(d.order);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Correction failed.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Manage ${order.orderNumber}`} wide>
      <div className="space-y-5">
        {/* Student info */}
        <div className="rounded-xl bg-white/[0.03] p-4 grid sm:grid-cols-2 gap-2 text-xs">
          <p className="text-zinc-400">Name: <span className="text-white font-medium">{order.user.name}</span></p>
          <p className="text-zinc-400">Reg No: <span className="text-white font-medium">{order.user.regNo ?? "—"}</span></p>
          <p className="text-zinc-400">Phone: <span className="text-white font-medium">{order.user.phone ?? "—"}</span></p>
          <p className="text-zinc-400">Branch: <span className="text-white font-medium">{order.user.branch ?? "—"} {order.user.section ?? ""} · Yr {order.user.year ?? "—"}</span></p>
        </div>

        {/* Print config */}
        <div className="text-xs text-zinc-400 space-y-1">
          <p>Configuration: <span className="text-white">{order.paperSize} · {order.colorMode === "COLOR" ? "Colour" : "B&W"} · {order.sides === "DOUBLE" ? "Double" : "Single"} side · {order.copies} cop{order.copies > 1 ? "ies" : "y"}</span></p>
          <p>Pages: <span className="text-white">{order.pageSelection === "CUSTOM" ? (order.customPages ?? "custom") : "ALL"} — verified {order.totalPages} pages, billable {order.billablePages}</span></p>
          {order.paymentRef && <p>Payment ref: <span className="font-mono text-white">{order.paymentRef}</span></p>}
        </div>

        {/* Files + page count correction */}
        <div>
          <p className="text-sm font-bold text-white mb-2">Documents & page counts</p>
          <div className="space-y-2">
            {(detail?.files ?? []).map((f) => (
              <div key={f.id} className="rounded-xl border border-white/10 p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs text-white truncate">{f.originalName}</p>
                    <p className="text-[11px] text-zinc-500">
                      {formatBytes(f.sizeBytes)} ·{" "}
                      {f.pageCount != null ? (
                        <>Detected: <span className="text-white font-semibold">{f.pageCount}</span> pages {f.pageCountSource ? `(${f.pageCountSource.replaceAll("_", " ").toLowerCase()})` : ""}</>
                      ) : (
                        <span className="text-amber-400">{f.analysisError ?? "Page count could not be automatically determined. Please verify."}</span>
                      )}
                    </p>
                  </div>
                  <a href={`/api/files/${f.id}/download?mode=view`} target="_blank" rel="noopener noreferrer" className="rounded-lg p-2 text-zinc-400 hover:text-white hover:bg-white/10 shrink-0" aria-label="View file" title="Opens in a new tab">
                    <Eye className="h-4 w-4" />
                  </a>
                </div>
                <div className="flex gap-2 items-end">
                  <div className="flex-1">
                    <Label htmlFor={`pc-${f.id}`}>Correct page count</Label>
                    <Input
                      id={`pc-${f.id}`} type="number" min={1} placeholder={f.pageCount != null ? String(f.pageCount) : "e.g. 24"}
                      value={corrections[f.id] ?? ""}
                      onChange={(e) => setCorrections((c) => ({ ...c, [f.id]: e.target.value }))}
                    />
                  </div>
                  <Button size="sm" onClick={() => correctPageCount(f.id)} loading={busy}>Save</Button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Status update */}
        <div className="space-y-3">
          <p className="text-sm font-bold text-white">Update status</p>
          {options.length === 0 ? (
            <p className="text-xs text-zinc-500">This order is in a terminal state.</p>
          ) : (
            <>
              <Select value={nextStatus} onChange={(e) => setNextStatus(e.target.value)} aria-label="New status">
                <option value="">Select new status…</option>
                {options.map((s) => <option key={s} value={s}>{s.replaceAll("_", " ")}</option>)}
              </Select>
              <Input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
              <Button className="w-full" onClick={updateStatus} loading={busy} disabled={!nextStatus}>
                Apply status change
              </Button>
            </>
          )}
          <Link href={`/api/invoices/${order.id}`} target="_blank" rel="noopener" className="flex items-center justify-center gap-2 text-xs text-zinc-400 hover:text-white transition-colors">
            <Printer className="h-3.5 w-3.5" /> View invoice
          </Link>
        </div>
      </div>
    </Modal>
  );
}
