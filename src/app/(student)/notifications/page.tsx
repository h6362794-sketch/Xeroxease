"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, EmptyState, ErrorState, Skeleton, Button } from "@/components/ui";
import { api, ApiError } from "@/lib/api-client";
import { cn, timeAgo } from "@/lib/utils";
import { Bell } from "lucide-react";

interface NotificationItem {
  id: string;
  title: string;
  body: string | null;
  isRead: boolean;
  createdAt: string;
}

export default function NotificationsPage() {
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setItems(null);
    setError(null);
    try {
      const d = await api<{ notifications: NotificationItem[] }>("/api/notifications?take=50");
      setItems(d.notifications);
      if (d.notifications.some((n) => !n.isRead)) {
        api("/api/notifications", { method: "PATCH", json: { all: true } }).catch(() => {});
      }
    } catch (err) {
      setItems([]);
      setError(err instanceof ApiError ? err.message : "Notifications could not be loaded right now. Please try again.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="max-w-2xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-extrabold text-white tracking-tight">Notifications</h1>
        {items && items.length > 0 && !error && (
          <Button variant="ghost" size="sm" onClick={() => api("/api/notifications", { method: "PATCH", json: { all: true } }).catch(() => {})}>
            Mark all read
          </Button>
        )}
      </div>
      {items === null ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 rounded-xl" />)}</div>
      ) : error ? (
        <Card><ErrorState title="Could not load notifications" sub={error} onRetry={load} /></Card>
      ) : items.length === 0 ? (
        <Card><EmptyState title="You're all caught up." sub="Order updates will appear here." icon={<Bell className="h-8 w-8" />} /></Card>
      ) : (
        <ul className="space-y-2">
          {items.map((n) => (
            <li key={n.id} className={cn("card px-4 py-3.5", !n.isRead && "border-[#7c5cff]/40")}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-white">{n.title}</p>
                  {n.body && <p className="text-xs text-zinc-400 mt-0.5">{n.body}</p>}
                </div>
                <span className="text-[10px] text-zinc-600 shrink-0">{timeAgo(n.createdAt)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
