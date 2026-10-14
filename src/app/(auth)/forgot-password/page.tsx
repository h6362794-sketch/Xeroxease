"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { Button, Input, Label, FieldError } from "@/components/ui";
import { api, ApiError } from "@/lib/api-client";

/** Client-side mirror of the server's 32-character Crockford base32 code. */
function normalizeCode(value: string) {
  return value
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

export default function ForgotPasswordPage() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (normalizeCode(recoveryCode).length !== 32) {
      setError("Your recovery code should be 32 characters long. Check for a missing character.");
      return;
    }

    setLoading(true);
    try {
      await api("/api/auth/recovery/reset", {
        method: "POST",
        json: { identifier, recoveryCode, password },
      });
      router.push("/login?reset=1");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
      <h1 className="text-2xl font-extrabold text-white tracking-tight">Reset your password</h1>
      <p className="text-sm text-zinc-400 mt-1.5 mb-8">
        Enter the recovery code you saved when you set up your account. We never email passwords or reset
        links.
      </p>

      <form onSubmit={onSubmit} className="space-y-5" noValidate>
        <div>
          <Label htmlFor="identifier" required>Email or Registration Number</Label>
          <Input
            id="identifier"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder="you@university.edu or 21A91A0501"
            autoComplete="username"
            required
          />
        </div>

        <div>
          <Label htmlFor="recoveryCode" required>Recovery code</Label>
          <Input
            id="recoveryCode"
            value={recoveryCode}
            onChange={(e) => setRecoveryCode(e.target.value)}
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
            className="font-mono tracking-wider"
            spellCheck={false}
            autoComplete="one-time-code"
            required
          />
          <p className="text-xs text-zinc-500 mt-1.5">
            Spaces and dashes are ignored, and it is not case sensitive.
          </p>
        </div>

        <div>
          <Label htmlFor="newPassword" required>New password</Label>
          <Input
            id="newPassword"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
        </div>

        <div>
          <Label htmlFor="confirmPassword" required>Confirm new password</Label>
          <Input
            id="confirmPassword"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
        </div>

        <FieldError message={error ?? undefined} />
        <Button type="submit" className="w-full" size="lg" loading={loading}>
          Reset password
        </Button>

        <p className="text-sm text-zinc-400 text-center">
          Remembered it?{" "}
          <Link href="/login" className="text-[#b49aff] font-semibold hover:text-[#7c5cff] transition-colors">
            Sign in
          </Link>
        </p>
      </form>

      <div className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <p className="text-sm font-semibold text-zinc-200">Don&apos;t have a recovery code?</p>
        <p className="text-sm text-zinc-400 mt-1.5 leading-relaxed">
          If you set one up, check wherever you saved it — a password manager, a note, or your phone. Codes are
          single-use, so a code you already used will not work again.
        </p>
        <p className="text-sm text-zinc-400 mt-2 leading-relaxed">
          If you never created one, ask a XeroxEase administrator to verify your identity at the counter and issue
          you a new code. They cannot see your password, and neither can we.
        </p>
      </div>
    </motion.div>
  );
}
