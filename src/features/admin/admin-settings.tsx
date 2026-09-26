"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, Input, Label, Skeleton, Textarea } from "@/components/ui";
import { useToast } from "@/components/toast";
import { api, ApiError } from "@/lib/api-client";
import { UploadCloud, Trash2, Power } from "lucide-react";

interface SettingsData {
  enabled: boolean;
  fileName: string | null;
  mime: string | null;
  hasQr: boolean;
  instructions: string;
  accountDisplay: string;
}

export function AdminSettings() {
  const [qr, setQr] = useState<SettingsData | null>(null);
  const [instructions, setInstructions] = useState("");
  const [accountDisplay, setAccountDisplay] = useState("");
  const [retentionDays, setRetentionDays] = useState("30");
  const [queuePH, setQueuePH] = useState("900");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const data = await api<SettingsData>("/api/admin/payment-qr");
      setQr(data);
      setInstructions(data.instructions);
      setAccountDisplay(data.accountDisplay);
    } catch {
      setQr(null);
    }
    try {
      const s = await api<{ settings: { retentionDays: number; queuePagesPerHour: number } }>("/api/admin/settings");
      setRetentionDays(String(s.settings.retentionDays));
      setQueuePH(String(s.settings.queuePagesPerHour));
    } catch {
      // defaults
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function uploadQr(file: File) {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("qr", file);
      const res = await fetch("/api/admin/payment-qr", { method: "POST", body: fd });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Upload failed.");
      }
      toast("Payment QR updated.", "success");
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Upload failed.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function toggleQr() {
    setBusy(true);
    try {
      await api("/api/admin/payment-qr", { method: "PATCH", json: { enabled: !qr?.enabled } });
      toast(qr?.enabled ? "QR disabled." : "QR enabled.", "success");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Update failed.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function removeQr() {
    setBusy(true);
    try {
      await api("/api/admin/payment-qr", { method: "DELETE" });
      toast("QR removed.", "success");
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Removal failed.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings() {
    setSaving(true);
    try {
      await api("/api/admin/settings", {
        method: "PATCH",
        json: {
          paymentInstructions: instructions,
          paymentAccountDisplay: accountDisplay,
          retentionDays: Number(retentionDays),
          queuePagesPerHour: Number(queuePH),
        },
      });
      toast("Settings saved.", "success");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Save failed.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5 max-w-3xl">
      <div>
        <h1 className="text-2xl font-extrabold text-white tracking-tight">System Settings</h1>
        <p className="text-sm text-zinc-500 mt-1">Payment configuration and operational controls.</p>
      </div>

      {/* Payment QR */}
      <Card className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-white">Payment QR code</h2>
          {qr?.hasQr && (
            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${qr.enabled ? "text-emerald-300 bg-emerald-500/10 border-emerald-500/20" : "text-zinc-400 bg-white/5 border-white/10"}`}>
              {qr.enabled ? "Active" : "Disabled"}
            </span>
          )}
        </div>

        {qr?.hasQr ? (
          <div className="flex flex-wrap items-center gap-4">
            <div className="rounded-xl bg-white p-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/api/payment/qr/image" alt="Current payment QR" className="h-32 w-32 object-contain" />
            </div>
            <div className="text-xs text-zinc-400 space-y-0.5">
              <p>{qr.fileName}</p>
              <p>{qr.mime}</p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-zinc-500">No QR uploaded yet. Students will see a fallback notice at payment.</p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => fileRef.current?.click()} loading={busy} icon={<UploadCloud className="h-4 w-4" />}>
            {qr?.hasQr ? "Replace QR" : "Upload QR"}
          </Button>
          {qr?.hasQr && (
            <>
              <Button variant="ghost" onClick={toggleQr} loading={busy} icon={<Power className="h-4 w-4" />}>
                {qr.enabled ? "Disable" : "Enable"}
              </Button>
              <Button variant="danger" onClick={removeQr} loading={busy} icon={<Trash2 className="h-4 w-4" />}>
                Remove
              </Button>
            </>
          )}
          <input
            ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
            onChange={(e) => e.target.files?.[0] && uploadQr(e.target.files[0])}
          />
        </div>
      </Card>

      {/* Payment instructions */}
      <Card className="space-y-4">
        <h2 className="font-bold text-white">Payment instructions</h2>
        <div>
          <Label htmlFor="acct">Account display name</Label>
          <Input id="acct" value={accountDisplay} onChange={(e) => setAccountDisplay(e.target.value)} maxLength={120} />
        </div>
        <div>
          <Label htmlFor="instr">Instructions shown to students at payment</Label>
          <Textarea id="instr" value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={1000} />
        </div>
      </Card>

      {/* Operations */}
      <Card className="space-y-4">
        <h2 className="font-bold text-white">Operations</h2>
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <Label htmlFor="ret">Document retention after completion (days)</Label>
            <Input id="ret" type="number" min={1} max={3650} value={retentionDays} onChange={(e) => setRetentionDays(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="queue">Queue capacity (pages/hour, used for estimates)</Label>
            <Input id="queue" type="number" min={50} max={100000} value={queuePH} onChange={(e) => setQueuePH(e.target.value)} />
          </div>
        </div>
        <Button onClick={saveSettings} loading={saving}>Save settings</Button>
      </Card>
    </div>
  );
}
