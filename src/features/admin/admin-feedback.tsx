"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, EmptyState, Skeleton, StarDisplay } from "@/components/ui";
import { useToast } from "@/components/toast";
import { api, ApiError } from "@/lib/api-client";
import { formatDateShort } from "@/lib/utils";
import { Star, EyeOff, Eye } from "lucide-react";

interface FeedbackRow {
  id: string;
  rating: number;
  comment: string | null;
  orderNumber: string;
  moderation: string | null;
  createdAt: string;
}

interface FeedbackData {
  feedback: FeedbackRow[];
  total: number;
  avgRating: number | null;
  count: number;
  distribution: { rating: number; count: number }[];
}

export function AdminFeedback({ canModerate = false }: { canModerate?: boolean }) {
  const [data, setData] = useState<FeedbackData | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      setData(await api<FeedbackData>("/api/admin/feedback"));
    } catch {
      setData({ feedback: [], total: 0, avgRating: null, count: 0, distribution: [5, 4, 3, 2, 1].map((r) => ({ rating: r, count: 0 })) });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function moderate(id: string, moderation: "HIDDEN" | "SHOWN") {
    try {
      await api("/api/admin/feedback", { method: "PATCH", json: { id, moderation } });
      toast(moderation === "HIDDEN" ? "Feedback hidden." : "Feedback restored.", "success");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Moderation failed.", "error");
    }
  }

  if (!data) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-40 rounded-2xl" />
        {[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 rounded-xl" />)}
      </div>
    );
  }

  const maxDist = Math.max(1, ...data.distribution.map((d) => d.count));

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-extrabold text-white tracking-tight">Feedback & Ratings</h1>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="flex flex-col items-center justify-center text-center">
          <p className="text-4xl font-extrabold text-white">{data.avgRating ?? "—"}</p>
          <StarDisplay rating={Math.round(data.avgRating ?? 0)} />
          <p className="text-xs text-zinc-500 mt-2">{data.count} rating{data.count === 1 ? "" : "s"}</p>
        </Card>
        <Card className="sm:col-span-2">
          <p className="text-sm font-bold text-white mb-3">Rating distribution</p>
          <div className="space-y-2">
            {data.distribution.map((d) => (
              <div key={d.rating} className="flex items-center gap-3">
                <span className="text-xs text-zinc-400 w-8">{d.rating}★</span>
                <div className="flex-1 h-4 rounded bg-white/5 overflow-hidden">
                  <div
                    className="h-full rounded bg-gradient-to-r from-[#7c5cff] to-[#4f46e5] transition-all"
                    style={{ width: `${(d.count / maxDist) * 100}%` }}
                  />
                </div>
                <span className="text-xs font-bold text-white w-8 text-right">{d.count}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {data.feedback.length === 0 ? (
        <Card><EmptyState title="No feedback submitted yet." icon={<Star className="h-8 w-8" />} /></Card>
      ) : (
        <ul className="space-y-3">
          {data.feedback.map((f) => (
            <li key={f.id} className={`card p-4 ${f.moderation === "HIDDEN" ? "opacity-50" : ""}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  <StarDisplay rating={f.rating} />
                  <span className="text-xs text-zinc-500">{f.orderNumber}</span>
                  <span className="text-[10px] text-zinc-600">{formatDateShort(f.createdAt)}</span>
                </div>
                {canModerate && (
                  <Button
                    size="sm" variant="ghost"
                    onClick={() => moderate(f.id, f.moderation === "HIDDEN" ? "SHOWN" : "HIDDEN")}
                    icon={f.moderation === "HIDDEN" ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                  >
                    {f.moderation === "HIDDEN" ? "Restore" : "Hide"}
                  </Button>
                )}
              </div>
              {f.comment && <p className="text-sm text-zinc-300 mt-2">{f.comment}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
