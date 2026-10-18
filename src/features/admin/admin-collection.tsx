"use client";

// Collection desk. A student shows their collection code at the counter; staff check it, then
// confirm the hand-over. Confirming consumes the code (single use) and completes the order.
//
// Lost-code override (Super Admin only): when a student cannot present the code, a Super Admin may
// complete the order after checking the student's identity in person. The rules are enforced by
// POST /api/admin/collection/override (see src/server/collection.ts). The reason is recorded in the
// audit log, not on the student's timeline. Procedure: SECURITY.md, "Lost collection code".

import { useState } from "react";
import { Button, Card, Input, Label, Textarea } from "@/components/ui";
import { useToast } from "@/components/toast";
import { api, ApiError } from "@/lib/api-client";
import { PackageCheck, Search, ShieldAlert } from "lucide-react";

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

const OVERRIDE_REASON_MIN = 20;

export function AdminCollection({ isSuperAdmin = false }: { isSuperAdmin?: boolean }) {
  const toast = useToast();
  const [code, setCode] = useState("");
  const [checked, setChecked] = useState<CheckedOrder | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastCollected, setLastCollected] = useState<string | null>(null);

  // Override form state
  const [ovOrderNumber, setOvOrderNumber] = useState("");
  const [ovConfirm, setOvConfirm] = useState("");
  const [ovReason, setOvReason] = useState("");
  const [ovIdentity, setOvIdentity] = useState(false);

  const trimmed = code.trim();
  const ovNumber = ovOrderNumber.trim();
  const ovReady =
    ovNumber.length > 0 &&
    ovConfirm.trim() === ovNumber &&
    ovReason.trim().length >= OVERRIDE_REASON_MIN &&
    ovIdentity;

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
      // The code may have been used by another desk in the meantime; check again before retrying.
      setChecked(null);
      toast(err instanceof ApiError ? err.message : "Could not confirm collection.", "error");
    }
  }

  async function overrideCollection() {
    if (!ovReady) return;
    setBusy(true);
    try {
      const res = await api<{ ok: true; orderNumber: string }>("/api/admin/collection/override", {
        method: "POST",
        json: {
          orderNumber: ovNumber,
          confirmOrderNumber: ovConfirm.trim(),
          reason: ovReason.trim(),
          identityChecked: true,
        },
      });
      setLastCollected(res.orderNumber);
      setOvOrderNumber("");
      setOvConfirm("");
      setOvReason("");
      setOvIdentity(false);
      toast(`${res.orderNumber} completed by override. The audit log records the reason.`, "success");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "The override was not applied.", "error");
    } finally {
      setBusy(false);
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
            <Button onClick={() => void confirmCollected()} disabled={busy} icon={<PackageCheck className="h-4 w-4" />}>
              Confirm collected
            </Button>
          </div>
        </Card>
      )}

      {lastCollected && <p className="text-sm text-emerald-300">Last collected: {lastCollected}</p>}

      {isSuperAdmin && (
        <Card>
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-amber-300">
              <ShieldAlert className="h-4 w-4" />
              <h2 className="text-base font-semibold">Lost collection code (Super Admin only)</h2>
            </div>
            <p className="text-sm text-zinc-400">
              Use this only when the student cannot present their code, and you have checked their identity in person
              (for example, their student ID card matches the registration number). This completes the order, burns its
              code, and writes an audit entry with your reason. It cannot be undone from this screen.
            </p>

            <div className="space-y-1.5">
              <Label htmlFor="ov-order" required>Order number</Label>
              <Input
                id="ov-order"
                value={ovOrderNumber}
                onChange={(e) => setOvOrderNumber(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                placeholder="XE-2026-000000"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ov-confirm" required>Type the order number again</Label>
              <Input
                id="ov-confirm"
                value={ovConfirm}
                onChange={(e) => setOvConfirm(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ov-reason" required>Reason (at least {OVERRIDE_REASON_MIN} characters)</Label>
              <Textarea
                id="ov-reason"
                value={ovReason}
                onChange={(e) => setOvReason(e.target.value)}
                rows={3}
                maxLength={500}
              />
            </div>
            <label className="flex items-start gap-2 text-sm text-zinc-300">
              <input
                type="checkbox"
                className="mt-1"
                checked={ovIdentity}
                onChange={(e) => setOvIdentity(e.target.checked)}
              />
              <span>I checked the student&apos;s identity in person.</span>
            </label>

            <Button variant="ghost" onClick={() => void overrideCollection()} disabled={busy || !ovReady}>
              Complete without code
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
