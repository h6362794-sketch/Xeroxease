"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card, EmptyState, FieldError, Input, Label, Select, Skeleton } from "@/components/ui";
import { PaymentStatusBadge, StatusBadge } from "@/components/status-badge";
import { api, ApiError } from "@/lib/api-client";
import { formatCurrencyINR, formatDateShort, timeAgo } from "@/lib/utils";
import { Search, ArrowRight, RefreshCw } from "lucide-react";
import { statusLabel } from "@/lib/order-status";
import { paymentMethodLabel } from "@/lib/status-meta";

interface LookupRow {
  id: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  paymentMethod: string | null;
  totalAmount: number;
  totalPages: number;
  copies: number;
  colorMode: string;
  paperSize: string;
  createdAt: string;
  updatedAt: string;
  user: { name: string; email: string; regNo: string | null; phone: string | null };
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

export function AdminOrderLookup() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("ALL");
  const [paymentStatus, setPaymentStatus] = useState("ALL");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<LookupRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "20" });
      if (q.trim()) params.set("q", q.trim());
      if (status !== "ALL") params.set("status", status);
      if (paymentStatus !== "ALL") params.set("paymentStatus", paymentStatus);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const data = await api<{ orders: LookupRow[]; total: number; pageCount: number }>(
        `/api/admin/orders/lookup?${params}`
      );
      setRows(data.orders);
      setTotal(data.total);
      setPageCount(data.pageCount);
    } catch (err) {
      setRows([]);
      setError(err instanceof ApiError ? err.message : "Search failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [q, status, paymentStatus, from, to, page]);

  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [load]);

  function reset() {
    setQ("");
    setStatus("ALL");
    setPaymentStatus("ALL");
    setFrom("");
    setTo("");
    setPage(1);
  }

  return (
    <div className="space-y-5 min-w-0 max-w-6xl">
      <div>
        <h1 className="text-2xl font-extrabold text-white tracking-tight">Order Lookup</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Find an order by order number/ID, student name, email or registration number. Full details are one click away.
        </p>
      </div>

      <Card className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="md:col-span-2">
            <Label htmlFor="lookup-q">Order number, order ID or student</Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" aria-hidden="true" />
              <Input
                id="lookup-q"
                className="pl-10"
                value={q}
                onChange={(e) => { setQ(e.target.value); setPage(1); }}
                placeholder="e.g. XE-2026-000042, a UUID, name, email or reg no."
                maxLength={100}
                autoComplete="off"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="lookup-status">Order status</Label>
            <Select id="lookup-status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="ALL">All statuses</option>
              {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
            </Select>
          </div>
          <div>
            <Label htmlFor="lookup-payment">Payment status</Label>
            <Select id="lookup-payment" value={paymentStatus} onChange={(e) => { setPaymentStatus(e.target.value); setPage(1); }}>
              <option value="ALL">All payments</option>
              <option value="PAYMENT_PENDING">Payment pending</option>
              <option value="PAYMENT_UNDER_REVIEW">Under verification</option>
              <option value="PAYMENT_CONFIRMED">Paid</option>
              <option value="PAYMENT_REJECTED">Payment rejected</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="lookup-from">Placed from</Label>
            <Input id="lookup-from" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} />
          </div>
          <div>
            <Label htmlFor="lookup-to">Placed until</Label>
            <Input id="lookup-to" type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} />
          </div>
        </div>
        <FieldError message={error ?? undefined} />
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={load} loading={loading} icon={<Search className="h-4 w-4" />}>Search</Button>
          <Button variant="ghost" onClick={reset}>Reset filters</Button>
          {rows !== null && (
            <p className="text-xs text-zinc-500" role="status" aria-live="polite">
              {loading ? "Searching…" : `${total} order${total === 1 ? "" : "s"} found`}
            </p>
          )}
        </div>
      </Card>

      {rows === null ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading search results">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
        </div>
      ) : rows.length === 0 && !error ? (
        <Card>
          <EmptyState title="No matching orders" sub="Try a different order number, student, status or date range." icon={<Search className="h-8 w-8" />} />
        </Card>
      ) : (
        <>
          <Card className="hidden p-0 md:block overflow-x-auto">
            <table className="w-full text-sm min-w-[780px]">
              <caption className="sr-only">Order lookup results</caption>
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-zinc-500 border-b border-white/10">
                  <th scope="col" className="px-4 py-3">Order</th>
                  <th scope="col" className="px-4 py-3">Student</th>
                  <th scope="col" className="px-4 py-3">Print</th>
                  <th scope="col" className="px-4 py-3">Amount</th>
                  <th scope="col" className="px-4 py-3">Status</th>
                  <th scope="col" className="px-4 py-3"><span className="sr-only">Open</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id} className="border-b border-white/5 hover:bg-white/[0.03]">
                    <td className="px-4 py-3">
                      <Link href={`/admin/orders/${o.id}`} className="font-semibold text-white hover:text-[#b49aff]">{o.orderNumber}</Link>
                      <p className="text-[11px] text-zinc-500">{formatDateShort(o.createdAt)}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-xs text-white">{o.user.name}</p>
                      <p className="text-[11px] text-zinc-500">{o.user.regNo ?? o.user.email}</p>
                    </td>
                    <td className="px-4 py-3 text-xs text-zinc-400">
                      {o.paperSize} · {o.colorMode === "COLOR" ? "Colour" : "B&W"} · ×{o.copies}
                      <br /><span className="text-zinc-500">{o.totalPages} pages · {o._count.files} file(s)</span>
                    </td>
                    <td className="px-4 py-3 font-bold text-white whitespace-nowrap">{formatCurrencyINR(o.totalAmount)}</td>
                    <td className="px-4 py-3">
                      <div className="space-y-1.5">
                        <StatusBadge status={o.status} />
                        <PaymentStatusBadge status={o.paymentStatus} />
                      </div>
                      <p className="mt-1 text-[10px] text-zinc-500">{paymentMethodLabel(o.paymentMethod)} · {timeAgo(o.updatedAt)}</p>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link href={`/admin/orders/${o.id}`} className="inline-flex min-h-11 items-center gap-1 rounded-xl px-3 text-xs font-semibold text-zinc-300 hover:bg-white/10 hover:text-white">
                        Open <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <ul className="space-y-3 md:hidden">
            {rows.map((o) => (
              <li key={o.id}>
                <Link href={`/admin/orders/${o.id}`} className="block card p-4">
                  <div className="flex items-start justify-between gap-2">
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
                  <p className="mt-2 text-[11px] text-zinc-500">{o.totalPages} pages · {o._count.files} file(s) · {formatDateShort(o.createdAt)}</p>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      {pageCount > 1 && (
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button variant="ghost" size="md" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</Button>
          <span className="text-xs text-zinc-500">Page {page} of {pageCount}</span>
          <Button variant="ghost" size="md" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      )}

      {error && (
        <p className="text-xs text-zinc-500 flex items-center gap-1.5">
          <RefreshCw className="h-3 w-3" /> Fix the filters or retry the search.
        </p>
      )}
    </div>
  );
}
