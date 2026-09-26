"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, EmptyState, Input, Select, Skeleton, Badge } from "@/components/ui";
import { api } from "@/lib/api-client";
import { formatDate } from "@/lib/utils";
import { Search, ScrollText } from "lucide-react";

interface AuditRow {
  id: string;
  action: string;
  actor: { name: string; role: string } | null;
  targetType: string | null;
  targetId: string | null;
  metadata: unknown;
  ip: string | null;
  createdAt: string;
}

const RISK_COLORS: Record<string, string> = {
  LOGIN_FAILED: "text-amber-300 bg-amber-500/10 border-amber-500/20",
  ADMIN_LOGIN_FAILED: "text-amber-300 bg-amber-500/10 border-amber-500/20",
  FILE_ACCESS_DENIED: "text-red-300 bg-red-500/10 border-red-500/20",
  USER_DISABLED: "text-red-300 bg-red-500/10 border-red-500/20",
  PAYMENT_REJECTED: "text-amber-300 bg-amber-500/10 border-amber-500/20",
};

export function AdminAuditLogs() {
  const [logs, setLogs] = useState<AuditRow[] | null>(null);
  const [actions, setActions] = useState<string[]>([]);
  const [action, setAction] = useState("ALL");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  const load = useCallback(async () => {
    setLogs(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "30" });
      if (action !== "ALL") params.set("action", action);
      if (q.trim()) params.set("q", q.trim());
      const data = await api<{ logs: AuditRow[]; actions: string[]; total: number }>(`/api/admin/audit-logs?${params}`);
      setLogs(data.logs);
      setActions(data.actions);
      setTotal(data.total);
    } catch {
      setLogs([]);
    }
  }, [action, q, page]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const pages = Math.max(1, Math.ceil(total / 30));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-extrabold text-white tracking-tight">Audit Logs</h1>
        <p className="text-sm text-zinc-500 mt-1">Immutable record of privileged actions.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
          <Input className="pl-10" placeholder="Search target type / id…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} aria-label="Search audit logs" />
        </div>
        <Select value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} aria-label="Filter by action">
          <option value="ALL">All actions</option>
          {actions.map((a) => <option key={a} value={a}>{a}</option>)}
        </Select>
      </div>

      {logs === null ? (
        <div className="space-y-2">{[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-12 rounded-xl" />)}</div>
      ) : logs.length === 0 ? (
        <Card><EmptyState title="No audit entries found." icon={<ScrollText className="h-8 w-8" />} /></Card>
      ) : (
        <ul className="space-y-2">
          {logs.map((l) => (
            <li key={l.id} className="card px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2 min-w-0">
                  <Badge className={RISK_COLORS[l.action] ?? "text-zinc-300 bg-white/5 border-white/10"}>
                    {l.action.replaceAll("_", " ")}
                  </Badge>
                  <span className="text-xs text-zinc-400">
                    {l.actor ? `${l.actor.name} (${l.actor.role.replaceAll("_", " ").toLowerCase()})` : "system"}
                  </span>
                  {l.targetType && l.targetId && (
                    <span className="text-[11px] text-zinc-600 font-mono truncate max-w-[180px]">
                      {l.targetType}:{l.targetId.slice(0, 8)}
                    </span>
                  )}
                </div>
                <span className="text-[11px] text-zinc-600 shrink-0">{formatDate(l.createdAt)}</span>
              </div>
              {l.metadata != null && Object.keys(l.metadata as object).length > 0 && (
                <p className="text-[11px] text-zinc-600 mt-1.5 font-mono truncate">
                  {JSON.stringify(l.metadata)}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span className="text-xs text-zinc-500">Page {page} of {pages} · {total} entries</span>
          <Button variant="ghost" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      )}
    </div>
  );
}
