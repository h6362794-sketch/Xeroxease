"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  Package, IndianRupee, FileText, Clock3, Printer, PackageCheck, CheckCircle2, XCircle, Star, Loader2,
} from "lucide-react";
import { Card, Skeleton, StarDisplay, EmptyState, ErrorState } from "@/components/ui";
import { api, ApiError } from "@/lib/api-client";
import { formatCurrencyINR, timeAgo } from "@/lib/utils";

interface Analytics {
  cards: {
    totalOrders: number; newOrders: number; processingOrders: number; printingOrders: number;
    readyOrders: number; completedOrders: number; cancelledOrders: number; pendingPayments: number;
    underReviewPayments: number; revenue: number; pagesToday: number; avgRating: number | null; feedbackCount: number;
  };
  recentFeedback: { id: string; rating: number; comment: string | null; orderNumber: string; createdAt: string }[];
  statusDistribution: { status: string; count: number }[];
  colourSplit: { colorMode: string; count: number }[];
}

const STATUS_LABELS: Record<string, string> = {
  ORDER_PLACED: "Placed", PAYMENT_PENDING: "Pay Pending", PAYMENT_UNDER_REVIEW: "Pay Review",
  PAYMENT_CONFIRMED: "Confirmed", DOCUMENTS_RECEIVED: "Docs Received", PROCESSING: "Processing",
  PRINTING: "Printing", QUALITY_CHECK: "Quality", READY_FOR_COLLECTION: "Ready", COMPLETED: "Completed",
  CANCELLED: "Cancelled", FAILED: "Failed",
  ORDER_RECEIVED: "Received", ACCEPTED: "Accepted", READY_FOR_PICKUP: "Ready pickup",
  DELIVERED: "Delivered", REJECTED: "Rejected",
};

export function AdminDashboard({ role }: { role: string }) {
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await api<Analytics>("/api/admin/analytics");
      setData(next);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Dashboard metrics could not be loaded right now. Please try again.");
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  if (!data) {
    if (error) {
      return (
        <div className="space-y-5">
          <div>
            <h1 className="text-2xl font-extrabold text-white tracking-tight">Dashboard</h1>
            <p className="text-sm text-zinc-500 mt-1">
              {role === "SUPER_ADMIN" ? "Super admin view — full control." : "Operations overview."}
            </p>
          </div>
          <Card>
            <ErrorState title="Could not load dashboard metrics" sub={error} onRetry={load} />
          </Card>
        </div>
      );
    }
    return (
      <div className="space-y-5">
        <Skeleton className="h-9 w-56" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}
        </div>
      </div>
    );
  }

  const c = data.cards;
  const maxStatus = Math.max(1, ...data.statusDistribution.map((s) => s.count));

  const cards = [
    { label: "Total orders", value: c.totalOrders, icon: Package, href: "/admin/orders" },
    { label: "Revenue (confirmed)", value: formatCurrencyINR(c.revenue), icon: IndianRupee, href: "/admin/payments?state=CONFIRMED" },
    { label: "New today", value: c.newOrders, icon: FileText, href: "/admin/orders" },
    { label: "Payments under review", value: c.underReviewPayments, icon: Clock3, href: "/admin/payments" },
    { label: "Processing", value: c.processingOrders, icon: Loader2, href: "/admin/orders" },
    { label: "Printing", value: c.printingOrders, icon: Printer, href: "/admin/orders" },
    { label: "Ready for pickup", value: c.readyOrders, icon: PackageCheck, href: "/admin/orders" },
    { label: "Pages today", value: c.pagesToday, icon: FileText, href: "/admin/orders" },
    { label: "Completed", value: c.completedOrders, icon: CheckCircle2, href: "/admin/orders" },
    { label: "Cancelled", value: c.cancelledOrders, icon: XCircle, href: "/admin/orders" },
    { label: "Avg rating", value: c.avgRating ? `${c.avgRating} / 5` : "—", icon: Star, href: "/admin/feedback" },
    { label: "Feedback count", value: c.feedbackCount, icon: Star, href: "/admin/feedback" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-white tracking-tight">Dashboard</h1>
        <p className="text-sm text-zinc-500 mt-1">
          {role === "SUPER_ADMIN" ? "Super admin view — full control." : "Operations overview."}
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map((card, i) => (
          <motion.div key={card.label} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04, duration: 0.3 }}>
            <Link href={card.href} className="block card p-4 hover:border-white/25 transition-colors h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60 rounded-2xl">
              <div className="flex items-center gap-2 text-zinc-500 mb-2">
                <card.icon className="h-4 w-4" />
                <span className="text-[11px] font-semibold uppercase tracking-wider truncate">{card.label}</span>
              </div>
              <p className="text-2xl font-extrabold text-white truncate">{card.value}</p>
            </Link>
          </motion.div>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <h2 className="font-bold text-white mb-4">Orders by status</h2>
          <div className="space-y-2.5">
            {data.statusDistribution.length === 0 && <p className="text-sm text-zinc-500">No orders yet.</p>}
            {data.statusDistribution
              .sort((a, b) => b.count - a.count)
              .map((s) => (
                <div key={s.status} className="flex items-center gap-3">
                  <span className="text-xs text-zinc-400 w-24 shrink-0 truncate">{STATUS_LABELS[s.status] ?? s.status}</span>
                  <div className="flex-1 h-5 rounded-md bg-white/5 overflow-hidden">
                    <motion.div
                      className="h-full rounded-md bg-gradient-to-r from-[#7c5cff] to-[#4f46e5]"
                      initial={{ width: 0 }}
                      animate={{ width: `${(s.count / maxStatus) * 100}%` }}
                      transition={{ duration: 0.6, ease: "easeOut" }}
                    />
                  </div>
                  <span className="text-xs font-bold text-white w-8 text-right">{s.count}</span>
                </div>
              ))}
          </div>
        </Card>

        <Card>
          <h2 className="font-bold text-white mb-4">Recent feedback</h2>
          {data.recentFeedback.length === 0 ? (
            <EmptyState title="No feedback submitted yet." />
          ) : (
            <ul className="space-y-3">
              {data.recentFeedback.map((f) => (
                <li key={f.id} className="border-t border-white/5 pt-3 first:border-0 first:pt-0">
                  <div className="flex items-center justify-between gap-3">
                    <StarDisplay rating={f.rating} />
                    <span className="text-[10px] text-zinc-600">{timeAgo(f.createdAt)}</span>
                  </div>
                  {f.comment && <p className="text-xs text-zinc-400 mt-1.5 line-clamp-2">{f.comment}</p>}
                  <p className="text-[10px] text-zinc-600 mt-1">{f.orderNumber}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
