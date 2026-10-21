"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { ShieldCheck } from "lucide-react";
import { Button, Input, Label, FieldError } from "@/components/ui";
import { LogoFull } from "@/components/logo";
import { api, ApiError } from "@/lib/api-client";

export default function AdminLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [errorMeta, setErrorMeta] = useState<{ code?: string; requestId?: string; retryAfter?: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [retryCountdown, setRetryCountdown] = useState<number | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, []);

  function startRetryCountdown(seconds: number) {
    setRetryCountdown(seconds);
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = setInterval(() => {
      setRetryCountdown((prev) => {
        if (prev === null || prev <= 1) {
          if (countdownRef.current) clearInterval(countdownRef.current);
          return null;
        }
        return prev - 1;
      });
    }, 1000);
  }

  function formatError(err: unknown): { message: string; meta: { code?: string; requestId?: string; retryAfter?: number } | null } {
    if (err instanceof ApiError) {
      if (err.status === 503) {
        return {
          message: err.message || "Service temporarily unavailable. Please try again shortly.",
          meta: { code: err.code, requestId: err.requestId, retryAfter: err.retryAfter },
        };
      }
      if (err.status === 429) {
        return { message: err.message, meta: { code: err.code, requestId: err.requestId, retryAfter: err.retryAfter } };
      }
      if (err.status >= 500) {
        const suffix = err.requestId ? ` (Ref: ${err.requestId.slice(0, 8)})` : "";
        return { message: (err.message || "Something went wrong.") + suffix, meta: { code: err.code, requestId: err.requestId } };
      }
      return { message: err.message, meta: { code: err.code, requestId: err.requestId } };
    }
    if (err instanceof TypeError && err.message.toLowerCase().includes("fetch")) {
      return { message: "Network error. Check your connection and try again.", meta: null };
    }
    return { message: "Something went wrong. Please try again.", meta: null };
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setErrorMeta(null);
    if (countdownRef.current) clearInterval(countdownRef.current);
    setRetryCountdown(null);
    if (!email.trim() || !password) {
      setError("Please enter your email and password.");
      return;
    }
    setLoading(true);
    try {
      await api("/api/auth/admin-login", { method: "POST", json: { email: email.trim(), password } });
      router.push("/admin");
      router.refresh();
    } catch (err) {
      const { message, meta } = formatError(err);
      setError(message);
      setErrorMeta(meta);
      if (meta?.retryAfter && meta.retryAfter > 0 && meta.retryAfter < 120) {
        startRetryCountdown(meta.retryAfter);
      }
    } finally {
      setLoading(false);
    }
  }

  const isTransient = errorMeta?.code === "SERVICE_UNAVAILABLE" || errorMeta?.code === "SCHEMA_OUTDATED";

  return (
    <div className="relative min-h-screen flex items-center justify-center p-5 bg-gradient-to-b from-[#151132] via-[#0a0918] to-[#08080f] overflow-hidden">
      <div className="aurora opacity-60" aria-hidden="true" />
      <motion.div
        className="w-full max-w-md"
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        <div className="flex justify-center mb-8">
          <LogoFull size={46} />
        </div>
        <div className="glass-strong rounded-2xl p-7 sm:p-8">
          <div className="flex items-center gap-3 mb-6">
            <div className="rounded-xl bg-[#7c5cff]/15 p-2.5">
              <ShieldCheck className="h-5 w-5 text-[#b49aff]" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-white">Administrator sign in</h1>
              <p className="text-xs text-zinc-500">Authorized personnel only</p>
            </div>
          </div>
          <form onSubmit={onSubmit} className="space-y-5" noValidate>
            <div>
              <Label htmlFor="email" required>Admin Email</Label>
              <Input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required disabled={loading} />
            </div>
            <div>
              <Label htmlFor="password" required>Password</Label>
              <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required disabled={loading} />
            </div>
            {error && (
              <div
                role="alert"
                aria-live="assertive"
                className={`rounded-xl border p-3.5 text-sm ${
                  isTransient ? "border-amber-500/30 bg-amber-500/10 text-amber-200" : "border-red-500/30 bg-red-500/10 text-red-200"
                }`}
              >
                <p>{error}</p>
                {retryCountdown !== null && <p className="mt-2 text-xs opacity-80">You can retry in {retryCountdown}s.</p>}
                {errorMeta?.requestId && <p className="mt-2 text-xs opacity-60 font-mono break-all">Ref: {errorMeta.requestId}</p>}
              </div>
            )}
            {!error && <FieldError message={undefined} />}
            <Button type="submit" className="w-full" size="lg" loading={loading} disabled={loading || retryCountdown !== null}>
              {retryCountdown !== null ? `Try again in ${retryCountdown}s` : "Sign in securely"}
            </Button>
          </form>
        </div>
        <p className="text-xs text-zinc-600 mt-6 text-center">
          Admin accounts are provisioned internally. There is no public admin signup.
        </p>
        <p className="text-xs text-zinc-600 mt-2 text-center">
          <Link href="/" className="hover:text-zinc-400 underline">← Back to XeroxEase</Link>
        </p>
      </motion.div>
    </div>
  );
}
