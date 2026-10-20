"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  LayoutDashboard, Package, Banknote, Users, IndianRupee, Star, ScrollText, Settings, LogOut, Menu, X, ExternalLink,
  Search,
} from "lucide-react";
import { LogoMark } from "@/components/logo";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import type { SessionUser } from "@/server/auth";

const NAV = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard },
  { href: "/admin/orders", label: "Orders", icon: Package },
  { href: "/admin/orders/lookup", label: "Order Lookup", icon: Search },
  { href: "/admin/payments", label: "Payments", icon: Banknote },
  { href: "/admin/feedback", label: "Feedback", icon: Star },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/pricing", label: "Pricing", icon: IndianRupee },
  { href: "/admin/settings", label: "Settings", icon: Settings, superOnly: true },
  { href: "/admin/audit-logs", label: "Audit Logs", icon: ScrollText, superOnly: true },
];

export function AdminChrome({ user, children }: { user: SessionUser; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  async function logout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    router.push("/admin/login");
    router.refresh();
  }

  const nav = NAV.filter((n) => !n.superOnly || user.role === "SUPER_ADMIN");

  // Longest matching prefix wins, so /admin/orders/lookup does not also highlight
  // /admin/orders.
  const activeHref =
    pathname === "/admin"
      ? "/admin"
      : nav
          .filter((n) => n.href !== "/admin" && (pathname === n.href || pathname.startsWith(`${n.href}/`)))
          .sort((a, b) => b.href.length - a.href.length)[0]?.href ?? null;

  const links = (
    <nav className="space-y-1" aria-label="Admin">
      {nav.map((n) => {
        const active = n.href === activeHref;
        return (
          <Link
            key={n.href}
            href={n.href}
            onClick={() => setOpen(false)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60",
              active ? "bg-[#7c5cff] text-white" : "text-zinc-400 hover:text-white hover:bg-white/5"
            )}
          >
            <n.icon className="h-4 w-4" /> {n.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[250px_1fr]">
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex flex-col border-r border-white/10 bg-[#0a0a0c] p-5 sticky top-0 h-screen">
        <Link href="/admin" className="flex items-center gap-2.5 mb-8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60 rounded-xl w-fit">
          <LogoMark size={38} />
          <span className="leading-tight">
            <span className="block font-extrabold text-white">XeroxEase</span>
            <span className="block text-[10px] uppercase tracking-[0.18em] text-[#b49aff] font-bold">Admin Console</span>
          </span>
        </Link>
        {links}
        <div className="mt-auto pt-6 border-t border-white/10 space-y-2">
          <a href="/" target="_blank" rel="noopener" className="flex items-center gap-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors px-3.5">
            <ExternalLink className="h-3 w-3" /> View student site
          </a>
          <button onClick={logout} className="w-full flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm text-zinc-400 hover:text-white hover:bg-white/5 transition-colors">
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </div>
      </aside>

      {/* Mobile top bar */}
      <div className="lg:hidden sticky top-0 z-40 border-b border-white/10 bg-[#08080a]/90 backdrop-blur-lg h-16 flex items-center justify-between px-4">
        <Link href="/admin" className="flex items-center gap-2">
          <LogoMark size={34} />
          <span className="font-extrabold text-white">Admin</span>
        </Link>
        <button onClick={() => setOpen((v) => !v)} className="rounded-lg p-2 text-zinc-300 hover:bg-white/10" aria-expanded={open} aria-label="Toggle admin menu">
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>
      {open && (
        <div className="lg:hidden fixed inset-x-4 top-[72px] z-40 glass-strong rounded-2xl p-3">
          {links}
          <button onClick={logout} className="w-full flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm text-zinc-400 hover:bg-white/5 mt-2">
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </div>
      )}

      <main className="p-4 sm:p-8 min-w-0">{children}</main>
    </div>
  );
}
