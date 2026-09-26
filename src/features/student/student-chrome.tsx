"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Home, FilePlus2, Package, Bell, UserRound, LogOut } from "lucide-react";
import { LogoMark } from "@/components/logo";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import type { SessionUser } from "@/server/auth";

const NAV = [
  { href: "/dashboard", label: "Home", icon: Home },
  { href: "/orders/new", label: "New Order", icon: FilePlus2 },
  { href: "/orders", label: "Orders", icon: Package },
  { href: "/notifications", label: "Alerts", icon: Bell },
  { href: "/profile", label: "Profile", icon: UserRound },
];

interface NotificationItem {
  id: string;
  title: string;
  body: string | null;
  isRead: boolean;
  createdAt: string;
}

export function StudentChrome({ user, children }: { user: SessionUser; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [unread, setUnread] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const data = await api<{ notifications: NotificationItem[]; unread: number }>("/api/notifications?take=12");
        if (active) {
          setUnread(data.unread);
          setItems(data.notifications);
        }
      } catch {
        // silent
      }
    };
    load();
    const t = setInterval(load, 15000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [pathname]);

  async function logout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    router.push("/login");
    router.refresh();
  }

  async function openPanel() {
    setPanelOpen((v) => !v);
    if (!panelOpen && unread > 0) {
      await api("/api/notifications", { method: "PATCH", json: { all: true } }).catch(() => {});
      setUnread(0);
    }
  }

  return (
    <div className="min-h-screen pb-20 sm:pb-0">
      {/* Top bar */}
      <header className="sticky top-0 z-40 border-b border-white/10 bg-[#08080a]/85 backdrop-blur-lg">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 h-16 flex items-center justify-between">
          <Link href="/dashboard" className="flex items-center gap-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60 rounded-xl">
            <LogoMark size={36} />
            <span className="font-extrabold text-white tracking-tight hidden sm:block">Xerox<span className="brand-gradient-text">Ease</span></span>
          </Link>
          <div className="flex items-center gap-2">
            <span className="text-sm text-zinc-300 hidden sm:block mr-1">Hi, {user.name.split(" ")[0]}</span>
            <button
              onClick={openPanel}
              className="relative rounded-xl p-2.5 text-zinc-300 hover:bg-white/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60"
              aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
            >
              <Bell className="h-5 w-5" />
              {unread > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] rounded-full bg-[#7c5cff] text-[10px] font-bold text-white flex items-center justify-center px-1">
                  {unread > 9 ? "9+" : unread}
                </span>
              )}
            </button>
            <button
              onClick={logout}
              className="rounded-xl p-2.5 text-zinc-300 hover:bg-white/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60"
              aria-label="Sign out"
            >
              <LogOut className="h-5 w-5" />
            </button>
          </div>
        </div>
        {/* Notification panel */}
        {panelOpen && (
          <div className="absolute right-4 top-[68px] w-[min(24rem,92vw)] glass-strong rounded-2xl p-3 max-h-[70vh] overflow-y-auto shadow-2xl">
            <p className="text-sm font-bold text-white px-2 pt-1 pb-2">Notifications</p>
            {items.length === 0 && <p className="text-sm text-zinc-500 px-2 pb-2">You&apos;re all caught up.</p>}
            {items.map((n) => (
              <div key={n.id} className={cn("rounded-xl px-3 py-2.5", !n.isRead && "bg-[#7c5cff]/10")}>
                <p className="text-sm font-semibold text-white">{n.title}</p>
                {n.body && <p className="text-xs text-zinc-400 mt-0.5">{n.body}</p>}
                <p className="text-[10px] text-zinc-600 mt-1">{new Date(n.createdAt).toLocaleString("en-IN")}</p>
              </div>
            ))}
          </div>
        )}
      </header>

      <main className="mx-auto max-w-5xl px-4 sm:px-6 py-8">{children}</main>

      {/* Mobile bottom nav */}
      <nav className="sm:hidden fixed bottom-0 inset-x-0 z-40 border-t border-white/10 bg-[#0a0a0c]/95 backdrop-blur-lg" aria-label="Primary">
        <div className="grid grid-cols-5 h-16">
          {NAV.map((n) => {
            const active = pathname === n.href || (n.href !== "/dashboard" && pathname.startsWith(n.href));
            return (
              <Link
                key={n.href}
                href={n.href}
                className={cn("flex flex-col items-center justify-center gap-1 text-[10px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60", active ? "text-[#b49aff]" : "text-zinc-500")}
              >
                <n.icon className={cn("h-5 w-5", n.href === "/orders/new" && "text-white")} />
                {n.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
