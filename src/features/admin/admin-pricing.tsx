"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, Input, Skeleton, EmptyState } from "@/components/ui";
import { useToast } from "@/components/toast";
import { api, ApiError } from "@/lib/api-client";
import { formatCurrencyINR } from "@/lib/utils";

interface PriceRow {
  key: string;
  label: string;
  category: string;
  unit: string;
  unitPrice: number;
  isActive: boolean;
}

interface PriceHistory {
  id: string;
  actorId: string | null;
  actorRole: string | null;
  metadata: unknown;
  createdAt: string;
}

function historyLines(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object") return [];
  const changes = (metadata as { changes?: unknown }).changes;
  if (!Array.isArray(changes)) return [];
  return changes
    .filter((c): c is { key: string; from: number | null; to: number } =>
      Boolean(c) && typeof c === "object" && typeof (c as { key?: unknown }).key === "string"
    )
    .map((c) => `${c.key}: ${c.from ?? "—"} → ${c.to}`);
}

export function AdminPricing({ canEdit }: { canEdit: boolean }) {
  const [rows, setRows] = useState<PriceRow[] | null>(null);
  const [history, setHistory] = useState<PriceHistory[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api<{ pricing: PriceRow[]; history: PriceHistory[] }>("/api/admin/pricing");
      setRows(data.pricing);
      setHistory(data.history ?? []);
    } catch {
      setRows([]);
      setError("Pricing could not be loaded. Please retry.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    const items: { key: string; unitPrice: number }[] = [];
    for (const [key, raw] of Object.entries(edits)) {
      if (raw.trim() === "") continue;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0 || value > 10000 || Math.round(value * 100) !== value * 100) {
        toast("Prices must be finite, between 0 and 10000, with at most 2 decimals.", "error");
        return;
      }
      const original = rows?.find((r) => r.key === key)?.unitPrice;
      if (original === value) continue;
      items.push({ key, unitPrice: value });
    }
    if (items.length === 0) {
      toast("No changes to save.", "info");
      return;
    }
    setBusy(true);
    try {
      await api("/api/admin/pricing", { method: "PATCH", json: { items } });
      toast("Pricing updated for new orders. Existing orders keep their original amounts.", "success");
      setEdits({});
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Save failed.", "error");
    } finally {
      setBusy(false);
    }
  }

  if (!rows) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-72 rounded-2xl" />
      </div>
    );
  }

  const prints = rows.filter((r) => r.category === "PRINT");
  const finishings = rows.filter((r) => r.category === "FINISHING");

  return (
    <div className="space-y-5 max-w-3xl">
      <div>
        <h1 className="text-2xl font-extrabold text-white tracking-tight">Pricing</h1>
        <p className="text-sm text-zinc-500 mt-1">
          {canEdit ? "Changes apply immediately to new orders and are audited." : "Only Super Admins can modify pricing."}
        </p>
      </div>

      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}

      <Card className="space-y-5">
        <PriceGroup title="Printing" rows={prints} canEdit={canEdit} edits={edits} setEdits={setEdits} />
        <PriceGroup title="Finishing" rows={finishings} canEdit={canEdit} edits={edits} setEdits={setEdits} />
        {canEdit && (
          <div className="pt-2 border-t border-white/10 flex flex-wrap items-center gap-3">
            <Button onClick={save} loading={busy} className="min-h-11">Save changes</Button>
            <p className="text-[11px] text-zinc-500">
              Applies to new orders only. Existing totals and their pricing snapshots never change.
            </p>
          </div>
        )}
      </Card>

      <Card className="space-y-3">
        <h2 className="font-bold text-white">Price change history</h2>
        {history.length === 0 ? (
          <EmptyState title="No price changes recorded yet." sub="Every update is audited with the previous and new value, actor and timestamp." />
        ) : (
          <ul className="space-y-2">
            {history.map((h) => (
              <li key={h.id} className="rounded-xl bg-white/[0.03] px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-white">Price update</span>
                  <time className="text-zinc-500" dateTime={h.createdAt}>{new Date(h.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</time>
                </div>
                <p className="text-zinc-400 mt-1 break-words">{historyLines(h.metadata).join(" · ") || "Updated pricing configuration"}</p>
                <p className="text-[10px] text-zinc-600 mt-0.5">{h.actorRole?.toLowerCase() ?? "admin"} · {h.actorId ? h.actorId.slice(0, 8) : "unknown"}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function PriceGroup({
  title, rows, canEdit, edits, setEdits,
}: {
  title: string;
  rows: PriceRow[];
  canEdit: boolean;
  edits: Record<string, string>;
  setEdits: React.Dispatch<React.SetStateAction<Record<string, string>>>;
}) {
  return (
    <div>
      <p className="text-sm font-bold text-white mb-3">{title}</p>
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center justify-between gap-4 rounded-xl bg-white/[0.03] px-4 py-3">
            <div>
              <p className="text-sm text-white font-medium">{r.label}</p>
              <p className="text-[11px] text-zinc-500">{r.unit === "page" ? "per page" : "per item"}</p>
            </div>
            {canEdit ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-zinc-500">₹</span>
                <Input
                  type="number" min={0} max={10000} step="0.01" inputMode="decimal"
                  className="w-24 text-right"
                  value={edits[r.key] ?? String(r.unitPrice)}
                  onChange={(e) => setEdits((prev) => ({ ...prev, [r.key]: e.target.value }))}
                  aria-label={`Price for ${r.label}`}
                />
              </div>
            ) : (
              <span className="font-bold text-white">{formatCurrencyINR(r.unitPrice)}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
