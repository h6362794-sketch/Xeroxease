"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { Button, Input, Label, FieldError } from "@/components/ui";
import { api, ApiError } from "@/lib/api-client";

function ResetForm() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token") || "";
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      await api("/api/auth/reset-password", { method: "POST", json: { token, password } });
      setDone(true);
      setTimeout(() => router.push("/login"), 1600);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <div className="card p-6 text-center">
        <p className="text-sm text-zinc-300">This reset link is missing its token.</p>
        <Link href="/forgot-password" className="text-sm text-[#b49aff] mt-3 inline-block hover:text-[#7c5cff]">
          Request a new link
        </Link>
      </div>
    );
  }

  if (done) {
    return (
      <div className="card p-6 text-center">
        <p className="text-sm text-emerald-300 font-medium">Password updated.</p>
        <p className="text-sm text-zinc-400 mt-2">Redirecting you to sign in…</p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <div>
        <Label htmlFor="password" required>New Password</Label>
        <Input id="password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <p className="text-[11px] text-zinc-500 mt-1">8+ chars with upper, lower & a number.</p>
      </div>
      <div>
        <Label htmlFor="confirmPassword" required>Confirm Password</Label>
        <Input id="confirmPassword" type="password" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
      </div>
      <FieldError message={error ?? undefined} />
      <Button type="submit" className="w-full" size="lg" loading={loading}>
        Update password
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
      <h1 className="text-2xl font-extrabold text-white tracking-tight">Choose a new password</h1>
      <p className="text-sm text-zinc-400 mt-1.5 mb-8">All active sessions will be signed out for safety.</p>
      <Suspense fallback={<div className="skeleton h-40" />}>
        <ResetForm />
      </Suspense>
    </motion.div>
  );
}
