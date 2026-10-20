"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card, EmptyState, Input, Select, Skeleton } from "@/components/ui";
import { StatusBadge, PaymentStatusBadge } from "@/components/status-badge";
import { api } from "@/lib/api-client";
import { formatCurrencyINR, formatDateShort, timeAgo } from "@/lib/utils";
import { Search, Eye, Printer, RefreshCw } from "lucide-react";
import { statusLabel } from "@/lib/order-status";
import { paymentMethodLabel } from "@/lib/status-meta";

interface AdminOrder {
  id: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  paymentMethod: string | null;
  paperSize: string;
  colorMode: string;
  sides: string;
  copies: number;
  totalPages: number;
  totalAmount: number;
  createdAt: string;
  updatedAt: string;
  user: { name: string; email: string; regNo: string | null; phone: string | null; branch: string | null; section: string | null; year: number | null };
  _count: { files: number };
}

const STATUS_OPTIONS = [
  "ORDER_RECEIVED",
  "ACCEPTED",
  "PRINTING",
  "READY_FOR_PICKUP",
  "DELIVERED",
  "REJECTED",
  "CANCELLED",
  "READY_FOR_COLLECTION",
  "COMPLETED",
];

const PAYMENT_OPTIONS = [
  ["PAYMENT_PENDING", "Payment pending"],
  ["PAYMENT_UNDER_REVIEW", "Under verification"],
  ["PAYMENT_REJECTED", "Payment rejected"],
  ["PAYMENT_CONFIRMED", "Paid"],
] as const;

/**
 * Admin orders list. Status transitions are intentionally NOT duplicated here —
 * the detail screen reads `allowedNextStatuses` from the server, so this table
 * cannot drift from the authoritative state machine.
 */
export function AdminOrdersTable() {
  const [orders, setOrders] = useState<AdminOrder[] | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("ALL");
  const [paymentStatus, setPaymentStatus] = useState("ALL");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setOrders(null);
    setError(null);
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
      setError("Orders could not be loaded. Please retry.");
    }
  }, [q, status, paymentStatus, page]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const pages = Math.max(1, Math.ceil(total / 15));

  return (
    <div className="space-y-5 min-w-0">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-white tracking-tight">Orders</h1>
          <p className="text-sm text-zinc-500 mt-1">Review, accept, print and deliver student orders.</p>
        </div>
        <Link
          href="/admin/orders/lookup"
          className="btn-ghost inline-flex min-h-11 items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60"
        >
          <Search className="h-4 w-4" aria-hidden="true" /> Advanced lookup
        </Link>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" aria-hidden="true" />
          <Input
            className="pl-10"
            placeholder="Order no, name, reg no, phone…"
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1); }}
            aria-label="Search orders"
            maxLength={100}
          />
        </div>
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Status filter">
          <option value="ALL">All statuses</option>
          {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
        </Select>
        <Select value={paymentStatus} onChange={(e) => { setPaymentStatus(e.target.value); setPage(1); }} aria-label="Payment filter">
          <option value="ALL">All payments</option>
          {PAYMENT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select>
      </div>

      {orders === null ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading orders">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-16 rounded-xl" />)}
        </div>
      ) : error ? (
        <Card>
          <EmptyState
            title="Could not load orders"
            sub={error}
            icon={<RefreshCw className="h-8 w-8" />}
          />
        </Card>
      ) : orders.length === 0 ? (
        <Card><EmptyState title="No orders match your filters." /></Card>
      ) : (
        <>
          {/* Desktop table */}
          <Card className="hidden p-0 md:block overflow-x-auto">
            <table className="w-full text-sm min-w-[820px]">
              <caption className="sr-only">Orders matching the current filters</caption>
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-zinc-500 border-b border-white/10">
                  <th scope="col" className="px-4 py-3">Order</th>
                  <th scope="col" className="px-4 py-3">Student</th>
                  <th scope="col" className="px-4 py-3">Config</th>
                  <th scope="col" className="px-4 py-3">Amount</th>
                  <th scope="col" className="px-4 py-3">Status</th>
                  <th scope="col" className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} className="border-b border-white/5 hover:bg-white/[0.03] transition-colors">
                    <td className="px-4 py-3">
                      <Link href={`/admin/orders/${o.id}`} className="font-semibold text-white hover:text-[#b49aff] rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60">
                        {o.orderNumber}
                      </Link>
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
                      <p className="mt-1 text-[10px] text-zinc-500">Updated {timeAgo(o.updatedAt)}</p>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/admin/orders/${o.id}`}
                        className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-xs font-semibold text-zinc-300 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60"
                      >
                        <Eye className="h-3.5 w-3.5" aria-hidden="true" /> Manage
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {/* Mobile cards — no horizontal scrolling on phones. */}
          <ul className="space-y-3 md:hidden">
            {orders.map((o) => (
              <li key={o.id}>
                <Link
                  href={`/admin/orders/${o.id}`}
                  className="block card p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-white">{o.orderNumber}</p>
                      <p className="text-xs text-zinc-400 mt-0.5 truncate">{o.user.name} · {o.user.regNo ?? o.user.email}</p>
                    </div>
                    <span className="font-bold text-white whitespace-nowrap">{formatCurrencyINR(o.totalAmount)}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <StatusBadge status={o.status} />
                    <PaymentStatusBadge status={o.paymentStatus} />
                  </div>
                  <p className="mt-2 text-[11px] text-zinc-500">
                    {o.totalPages} pages · {o.paperSize} · ×{o.copies} · {o._count.files} file(s)
                  </p>
                  <p className="mt-1 text-[11px] text-zinc-500">
                    {paymentMethodLabel(o.paymentMethod)} · placed {formatDateShort(o.createdAt)} · updated {timeAgo(o.updatedAt)}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      {pages > 1 && (
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button variant="ghost" size="md" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span className="text-xs text-zinc-500">Page {page} of {pages} · {total} orders</span>
          <Button variant="ghost" size="md" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      )}

      <p className="text-[11px] text-zinc-600 flex items-center gap-1.5">
        <Printer className="h-3 w-3" aria-hidden="true" /> Totals are server-calculated at order time and are not affected by later price changes.
      </p>
    </div>
  );
}
