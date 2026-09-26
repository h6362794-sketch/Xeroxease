"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, Input, Skeleton } from "@/components/ui";
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

export function AdminPricing({ canEdit }: { canEdit: boolean }) {
  const [rows, setRows] = useState<PriceRow[] | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const data = await api<{ pricing: PriceRow[] }>("/api/admin/pricing");
      setRows(data.pricing);
    } catch {
      setRows([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    setBusy(true);
    try {
      const items = Object.entries(edits)
        .filter(([, v]) => v !== "" && Number(v) >= 0)
        .map(([key, v]) => ({ key, unitPrice: Number(v) }));
      if (items.length === 0) {
        toast("No changes to save.", "info");
        return;
      }
      await api("/api/admin/pricing", { method: "PATCH", json: { items } });
      toast("Pricing updated.", "success");
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

      <Card className="space-y-5">
        <PriceGroup title="Printing" rows={prints} canEdit={canEdit} edits={edits} setEdits={setEdits} />
        <PriceGroup title="Finishing" rows={finishings} canEdit={canEdit} edits={edits} setEdits={setEdits} />
        {canEdit && (
          <div className="pt-2 border-t border-white/10">
            <Button onClick={save} loading={busy}>Save changes</Button>
          </div>
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
                  type="number" min={0} step="0.5"
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
