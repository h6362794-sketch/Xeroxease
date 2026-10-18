"use client";

// Collection desk: a student shows their collection code at the counter; staff check it, then
// confirm the hand-over. Confirming consumes the code (single use) and completes the order. Until
// this page existed, the only way to complete a collected order was the status control, which
// left the code live. The status control now refuses that transition.

import { useState } from "react";
import { Button, Card, Input, Label } from "@/components/ui";
import { useToast } from "@/components/toast";
import { api, ApiError } from "@/lib/api-client";
import { PackageCheck, Search } from "lucide-react";

interface CheckedOrder {
  id: string;
  orderNumber: string;
  studentName: string;
  regNo: string | null;
  status: string;
}

interface CollectionResponse {
  ok: true;
  consumed: boolean;
  order: CheckedOrder;
}

export function AdminCollection() {
  const toast = useToast();
  const [code, setCode] = useState("");
  const [checked, setChecked] = useState<CheckedOrder | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastCollected, setLastCollected] = useState<string | null>(null);

  const trimmed = code.trim();

  async function send(consume: boolean) {
    setBusy(true);
    try {
      return await api<CollectionResponse>("/api/admin/collection", {
        method: "POST",
        json: { token: trimmed, consume },
      });
    } finally {
      setBusy(false);
    }
  }

  async function check() {
    if (trimmed.length < 10) return;
    try {
      const res = await send(false);
      setChecked(res.order);
    } catch (err) {
      setChecked(null);
      toast(err instanceof ApiError ? err.message : "Could not check that code.", "error");
    }
  }

  async function confirmCollected() {
    if (!checked) return;
    try {
      const res = await send(true);
      setLastCollected(res.order.orderNumber);
      setCode("");
      setChecked(null);
      toast(`${res.order.orderNumber} marked as collected.`, "success");
    } catch (err) {
      // The code may have been used by another desk in the meantime; re-check before retrying.
      setChecked(null);
      toast(err instanceof ApiError ? err.message : "Could not confirm collection.", "error");
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-white">Collection</h1>
        <p className="text-sm text-zinc-400 mt-1">
          Paste or type the collection code the student shows. Check it first, then confirm the hand-over. A confirmed code cannot be used again.
        </p>
      </div>

      <Card>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void check();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="collection-code" required>Collection code</Label>
            <Input
              id="collection-code"
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setChecked(null);
              }}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              className="font-mono"
              placeholder="Paste the code from the student's order page"
            />
          </div>
          <Button type="submit" disabled={busy || trimmed.length < 10} icon={<Search className="h-4 w-4" />}>
            Check code
          </Button>
        </form>
      </Card>

      {checked && (
        <Card>
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="space-y-1">
              <p className="text-xs uppercase tracking-wide text-zinc-500">Order</p>
              <p className="font-mono text-lg text-white">{checked.orderNumber}</p>
              <p className="text-sm text-zinc-300">
                {checked.studentName}
                {checked.regNo ? <span className="text-zinc-500"> · {checked.regNo}</span> : null}
              </p>
            </div>
            <Button
              onClick={() => void confirmCollected()}
              disabled={busy}
              icon={<PackageCheck className="h-4 w-4" />}
            >
              Confirm collected
            </Button>
          </div>
        </Card>
      )}

      {lastCollected && (
        <p className="text-sm text-emerald-300">Last collected: {lastCollected}</p>
      )}
    </div>
  );
}
