"use client";

import { useState } from "react";
import { Check, Copy, Download, RefreshCw, ShieldCheck, ShieldOff } from "lucide-react";
import { Button, Card, FieldError, Input, Label } from "@/components/ui";
import { api, ApiError } from "@/lib/api-client";

export interface RecoveryCodeStatusData {
  hasCode: boolean;
  createdAt: string | null;
  expiresAt: string | null;
  usedAt: string | null;
  issuedByAdmin: boolean;
}

export function recoveryCodeFilename() {
  return `xeroxease-recovery-code-${new Date().toISOString().slice(0, 10)}.txt`;
}

/** Offer the code as a plain text file — a real "save it somewhere" affordance. */
export function downloadRecoveryCode(code: string) {
  const body = [
    "XeroxEase recovery code",
    "========================",
    "",
    `Code: ${code}`,
    "",
    "Use this code with your email or registration number at",
    "/forgot-password to reset your password if you lose it.",
    "",
    "It can only be used once. After you use it, generate a new one.",
    "Nobody at XeroxEase can show you this code again — only you have it.",
    "",
  ].join("\n");

  const url = URL.createObjectURL(new Blob([body], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = recoveryCodeFilename();
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function RecoveryCodePanel({ initial }: { initial: RecoveryCodeStatusData }) {
  const [status, setStatus] = useState<RecoveryCodeStatusData>(initial);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function refreshStatus() {
    try {
      const next = await api<RecoveryCodeStatusData & { ok: true }>("/api/auth/recovery/status");
      setStatus({
        hasCode: next.hasCode,
        createdAt: next.createdAt,
        expiresAt: next.expiresAt,
        usedAt: next.usedAt,
        issuedByAdmin: next.issuedByAdmin,
      });
    } catch {
      // Non-fatal: the panel simply keeps showing the status it already has.
    }
  }

  async function onGenerate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api<{ ok: true; code: string }>("/api/auth/recovery/code", {
        method: "POST",
        json: { password },
      });
      setCode(res.code);
      setSaved(false);
      setCopied(false);
      setPassword("");
      await refreshStatus();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Could not generate a recovery code. Please try again."
      );
    } finally {
      setLoading(false);
    }
  }

  async function copy() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not access the clipboard. Please select and copy the code manually.");
    }
  }

  function dismiss() {
    setCode(null);
    setSaved(false);
    refreshStatus();
  }

  // ---------- The one-time reveal ----------
  if (code) {
    return (
      <Card className="space-y-5 border-[#7c5cff]/40">
        <div>
          <h2 className="text-base font-bold text-white">Your new recovery code</h2>
          <p className="text-sm text-zinc-400 mt-1">
            This is the only time it will be shown. Save it now — nobody, including XeroxEase staff, can
            retrieve it for you later.
          </p>
        </div>

        <p className="rounded-xl border border-zinc-700 bg-black/40 px-4 py-4 text-center font-mono text-base sm:text-lg tracking-widest text-white break-all select-all">
          {code}
        </p>

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={copy}>
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => downloadRecoveryCode(code)}>
            <Download className="h-4 w-4" /> Download
          </Button>
        </div>

        <label className="flex items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 cursor-pointer">
          <input
            type="checkbox"
            checked={saved}
            onChange={(e) => setSaved(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[#7c5cff]"
          />
          <span className="text-sm text-zinc-300">
            I have saved this code somewhere safe. I understand it can be used only once.
          </span>
        </label>

        <FieldError message={error ?? undefined} />
        <Button type="button" className="w-full" onClick={dismiss} disabled={!saved}>
          Done
        </Button>
      </Card>
    );
  }

  // ---------- Status + generate ----------
  return (
    <Card className="space-y-5">
      <div className="flex items-start gap-3">
        {status.hasCode && !status.usedAt ? (
          <ShieldCheck className="h-5 w-5 text-emerald-400 shrink-0 mt-0.5" />
        ) : (
          <ShieldOff className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
        )}
        <div>
          <h2 className="text-base font-bold text-white">Recovery code</h2>
          <p className="text-sm text-zinc-400 mt-1">
            {status.usedAt
              ? "Your recovery code has been used. Generate a new one now, or you will have no way back into your account if you forget your password."
              : status.hasCode
                ? "You have an active recovery code. Store it in your password manager or print it — it is the only way back into your account without an administrator."
                : "You have not set up a recovery code yet. Without one, the only way to recover a lost password is to visit the counter and have an administrator verify your identity."}
          </p>
          {status.createdAt && (
            <p className="text-xs text-zinc-500 mt-2">
              {status.issuedByAdmin ? "Issued by an administrator" : "Generated by you"} on{" "}
              {new Date(status.createdAt).toLocaleDateString(undefined, {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
              {status.usedAt &&
                ` · used ${new Date(status.usedAt).toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })}`}
              {status.expiresAt &&
                ` · expires ${new Date(status.expiresAt).toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })}`}
            </p>
          )}
        </div>
      </div>

      <form onSubmit={onGenerate} className="space-y-4 border-t border-zinc-800 pt-5">
        <div>
          <Label htmlFor="currentPassword" required>
            {status.hasCode ? "Enter your current password to generate a new code" : "Enter your current password"}
          </Label>
          <Input
            id="currentPassword"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            placeholder="••••••••"
            required
          />
          {status.hasCode && (
            <p className="text-xs text-zinc-500 mt-1.5">
              Generating a new code immediately replaces your existing one.
            </p>
          )}
        </div>
        <FieldError message={error ?? undefined} />
        <Button type="submit" loading={loading} className="w-full sm:w-auto">
          <RefreshCw className="h-4 w-4" />
          {status.hasCode ? "Generate a new recovery code" : "Generate my recovery code"}
        </Button>
      </form>
    </Card>
  );
}
