import Link from "next/link";
import { requirePageUser } from "@/server/auth";
import { prisma } from "@/lib/prisma";
import { Card, EmptyState, Badge } from "@/components/ui";
import { StatusBadge } from "@/components/status-badge";
import { FilePlus2, ArrowRight, FileText, Coins } from "lucide-react";
import { formatCurrencyINR, formatDateShort, timeAgo } from "@/lib/utils";
import { getRecoveryCodeStatus } from "@/server/recovery";
import { ShieldAlert } from "lucide-react";
import { SupportContact } from "@/components/support-contact";
import { statusLabel } from "@/lib/order-status";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await requirePageUser();

  const [activeOrder, recentOrders, stats, recovery] = await Promise.all([
    prisma.order.findFirst({
      where: { userId: user.id, status: { notIn: ["COMPLETED", "CANCELLED", "FAILED"] } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.order.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    prisma.order.aggregate({ where: { userId: user.id }, _count: true, _sum: { totalAmount: true } }),
    getRecoveryCodeStatus(user.id),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-white tracking-tight">
            Hey, {user.name.split(" ")[0]} 👋
          </h1>
          <p className="text-sm text-zinc-400 mt-1">What are we printing today?</p>
        </div>
        <Link
          href="/orders/new"
          className="btn-brand inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold"
        >
          <FilePlus2 className="h-5 w-5" /> Create New Order
        </Link>
      </div>

      {/* Top-of-dashboard support access. The number is public configuration,
          never hard-coded, and renders no call link when unset. */}
      <SupportContact variant="card" />

      {(!recovery.hasCode || recovery.usedAt) && (
        <Link
          href="/security"
          className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 hover:border-amber-500/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60"
        >
          <ShieldAlert className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
          <span className="text-sm">
            <span className="font-semibold text-amber-200">
              {recovery.usedAt ? "Your recovery code has been used." : "Protect your account."}
            </span>{" "}
            <span className="text-zinc-300">
              {recovery.usedAt
                ? "Generate a new one now — without an active code you cannot reset a forgotten password on your own."
                : "Create a recovery code so you can reset your password yourself if you ever forget it. Takes 20 seconds."}
            </span>
            <span className="ml-1 font-semibold text-[#b49aff]">Set it up →</span>
          </span>
        </Link>
      )}

      {activeOrder ? (
        <Link
          href={`/orders/${activeOrder.id}`}
          className="block card p-5 border-[#7c5cff]/40 hover:border-[#7c5cff]/70 transition-colors group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60"
        >
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-[#b49aff] font-semibold">Active order</p>
              <p className="text-lg font-bold text-white mt-1">{activeOrder.orderNumber}</p>
              <p className="text-sm text-zinc-400 mt-0.5">
                {activeOrder.paperSize} · {activeOrder.colorMode === "COLOR" ? "Colour" : "B&W"} · {activeOrder.totalPages} pages
              </p>
            </div>
            <div className="flex items-center gap-3">
              <StatusBadge status={activeOrder.status} />
              <ArrowRight className="h-4 w-4 text-zinc-500 group-hover:text-white group-hover:translate-x-1 transition-all" />
            </div>
          </div>
        </Link>
      ) : (
        <Card>
          <EmptyState
            title="No active orders"
            sub="Upload your first document to get started — it takes under a minute."
            icon={<FileText className="h-8 w-8" />}
          />
        </Card>
      )}

      <div className="grid grid-cols-2 gap-4">
        <Card>
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-white/5 p-2.5"><FileText className="h-5 w-5 text-zinc-300" /></div>
            <div>
              <p className="text-xs text-zinc-500 font-medium">Total orders</p>
              <p className="text-xl font-extrabold text-white">{stats._count}</p>
            </div>
          </div>
        </Card>
        <Card>
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-white/5 p-2.5"><Coins className="h-5 w-5 text-zinc-300" /></div>
            <div>
              <p className="text-xs text-zinc-500 font-medium">Total spend</p>
              <p className="text-xl font-extrabold text-white">{formatCurrencyINR(Number(stats._sum.totalAmount ?? 0))}</p>
            </div>
          </div>
        </Card>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-bold text-white">Recent orders</h2>
          <Link href="/orders" className="text-sm text-[#b49aff] hover:text-[#7c5cff] transition-colors font-medium">
            View all
          </Link>
        </div>
        {recentOrders.length === 0 ? (
          <Card><EmptyState title="No orders yet." sub="Your printing history will appear here." /></Card>
        ) : (
          <div className="space-y-3">
            {recentOrders.map((o) => (
              <Link
                key={o.id}
                href={`/orders/${o.id}`}
                className="block card px-5 py-4 hover:border-white/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-semibold text-white text-sm">{o.orderNumber}</p>
                    <p className="text-xs text-zinc-500 mt-0.5">
                      {formatDateShort(o.createdAt)} · {o.totalPages} pages · {o.copies} cop{o.copies > 1 ? "ies" : "y"}
                    </p>
                    <p className="text-[11px] text-zinc-600 mt-0.5">Updated {timeAgo(o.updatedAt)}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-bold text-white">{formatCurrencyINR(Number(o.totalAmount))}</span>
                    <Badge
                      className={
                        o.status === "COMPLETED"
                          ? "text-emerald-300 bg-emerald-500/10 border-emerald-500/20"
                          : "text-zinc-300 bg-white/5 border-white/10"
                      }
                    >
                      {statusLabel(o.status)}
                    </Badge>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
