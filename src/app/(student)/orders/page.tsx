"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button, Card, EmptyState, ErrorState, Input, Select, Skeleton } from "@/components/ui";
import { PaymentStatusBadge, StatusBadge } from "@/components/status-badge";
import { api, ApiError } from "@/lib/api-client";
import { formatCurrencyINR, formatDateShort, timeAgo } from "@/lib/utils";
import { Search, Package } from "lucide-react";

interface OrderRow {
  id: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  totalAmount: number;
  totalPages: number;
  copies: number;
  colorMode: string;
  paperSize: string;
  createdAt: string;
  updatedAt: string;
  feedback?: { id: string; rating: number } | null;
}

export default function MyOrdersPage() {
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("ALL");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  const load = useCallback(async () => {
    setOrders(null);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "10" });
      if (q.trim()) params.set("q", q.trim());
      if (status !== "ALL") params.set("status", status);
      const data = await api<{ orders: OrderRow[]; total: number }>(`/api/orders?${params}`);
      setOrders(data.orders);
      setTotal(data.total);
    } catch (err) {
      setOrders([]);
      setError(err instanceof ApiError ? err.message : "Orders could not be loaded right now. Please try again.");
    }
  }, [q, status, page]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const pages = Math.max(1, Math.ceil(total / 10));

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-extrabold text-white tracking-tight">My Orders</h1>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
          <Input
            className="pl-10"
            placeholder="Search by order number…"
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1); }}
            aria-label="Search orders"
          />
        </div>
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Filter by status" className="sm:w-56">
          <option value="ALL">All statuses</option>
          <option value="ORDER_RECEIVED">Order received</option>
          <option value="ACCEPTED">Order accepted</option>
          <option value="PRINTING">Printing</option>
          <option value="READY_FOR_PICKUP">Ready for pickup</option>
          <option value="DELIVERED">Delivered</option>
          <option value="REJECTED">Not accepted</option>
          <option value="CANCELLED">Cancelled</option>
        </Select>
      </div>

      {orders === null ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 rounded-2xl" />)}
        </div>
      ) : error ? (
        <Card>
          <ErrorState title="Could not load orders" sub={error} onRetry={load} />
        </Card>
      ) : orders.length === 0 ? (
        <Card>
          <EmptyState
            title="No orders found."
            sub="Upload a document to place your first order."
            icon={<Package className="h-8 w-8" />}
          />
        </Card>
      ) : (
        <ul className="space-y-3">
          {orders.map((o) => (
            <li key={o.id}>
              <Link
                href={`/orders/${o.id}`}
                className="block card px-5 py-4 hover:border-white/25 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-white text-sm">{o.orderNumber}</p>
                      <StatusBadge status={o.status} />
                      <PaymentStatusBadge status={o.paymentStatus} />
                    </div>
                    <p className="text-xs text-zinc-500 mt-1">
                      {formatDateShort(o.createdAt)} · {o.paperSize} · {o.colorMode === "COLOR" ? "Colour" : "B&W"} · {o.totalPages} pages · ×{o.copies}
                    </p>
                    <p className="text-[11px] text-zinc-600 mt-0.5">Last updated {timeAgo(o.updatedAt)}</p>
                  </div>
                  <span className="font-bold text-white">{formatCurrencyINR(o.totalAmount)}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-center gap-3 pt-2">
          <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span className="text-xs text-zinc-500">Page {page} of {pages}</span>
          <Button variant="ghost" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      )}
    </div>
  );
}
