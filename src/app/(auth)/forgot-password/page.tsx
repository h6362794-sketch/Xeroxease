"use client";

import { useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { Button, Input, Label, FieldError } from "@/components/ui";
import { api, ApiError } from "@/lib/api-client";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [devToken, setDevToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api<{ ok: boolean; devResetToken?: string }>("/api/auth/forgot-password", {
        method: "POST",
        json: { email },
      });
      setSent(true);
      setDevToken(res.devResetToken ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
      <h1 className="text-2xl font-extrabold text-white tracking-tight">Reset your password</h1>
      <p className="text-sm text-zinc-400 mt-1.5 mb-8">
        Enter your account email. If it exists, we&apos;ll create a reset link valid for 30 minutes.
      </p>

      {sent ? (
        <div className="card p-5 space-y-4">
          <p className="text-sm text-emerald-300 font-medium">Reset link created.</p>
          {devToken ? (
            <>
              <p className="text-xs text-zinc-400">
                Development mode: email delivery is disabled, so use the link below:
              </p>
              <Link
                href={`/reset-password?token=${encodeURIComponent(devToken)}`}
                className="text-sm text-[#b49aff] underline break-all hover:text-[#7c5cff] transition-colors"
              >
                Open reset link
              </Link>
            </>
          ) : (
            <p className="text-sm text-zinc-400">Check your email for the reset instructions.</p>
          )}
          <Link href="/login" className="block text-sm text-zinc-400 hover:text-white transition-colors">
            ← Back to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-5" noValidate>
          <div>
            <Label htmlFor="email" required>Email</Label>
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <FieldError message={error ?? undefined} />
          <Button type="submit" className="w-full" size="lg" loading={loading}>
            Create reset link
          </Button>
          <p className="text-sm text-zinc-400 text-center">
            Remembered it?{" "}
            <Link href="/login" className="text-[#b49aff] font-semibold hover:text-[#7c5cff] transition-colors">
              Sign in
            </Link>
          </p>
        </form>
      )}
    </motion.div>
  );
}
