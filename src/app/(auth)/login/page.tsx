"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { Button, Input, Label, FieldError } from "@/components/ui";
import { SupportContact } from "@/components/support-contact";
import { api, ApiError } from "@/lib/api-client";

export default function LoginPage() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [errorMeta, setErrorMeta] = useState<{ code?: string; requestId?: string; retryAfter?: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [retryCountdown, setRetryCountdown] = useState<number | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Read the query string on the client so the page stays statically renderable
  // (useSearchParams would force a Suspense boundary for a cosmetic banner).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("reset") === "1") {
      setNotice("Password reset. Sign in with your new password, then generate a fresh recovery code.");
    } else if (params.get("registered") === "1") {
      // Registration does not create a session, so this must read as an
      // invitation to sign in — never as if the user were already logged in.
      setNotice(
        "Account created. Sign in with the email and password you just chose. " +
          "After your first sign-in, open Profile → Security to generate your recovery code."
      );
    }
  }, []);

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
      // Map server codes to user-friendly guidance; server already sanitizes messages
      if (err.status === 503) {
        if (err.code === "SERVICE_UNAVAILABLE" || err.code === "SCHEMA_OUTDATED") {
          return {
            message: err.message || "Service is temporarily busy. Please wait a moment and try again.",
            meta: { code: err.code, requestId: err.requestId, retryAfter: err.retryAfter },
          };
        }
        return {
          message: "Service temporarily unavailable. Please try again shortly.",
          meta: { code: err.code, requestId: err.requestId, retryAfter: err.retryAfter },
        };
      }
      if (err.status === 429) {
        return {
          message: err.message,
          meta: { code: err.code, requestId: err.requestId, retryAfter: err.retryAfter },
        };
      }
      if (err.status === 422) {
        return { message: err.message, meta: { code: err.code } };
      }
      if (err.status === 401 || err.status === 403) {
        return { message: err.message, meta: { code: err.code } };
      }
      if (err.status >= 500) {
        // Include requestId for support correlation if present
        const suffix = err.requestId ? ` (Ref: ${err.requestId.slice(0, 8)})` : "";
        return {
          message: (err.message || "Something went wrong. Please try again.") + suffix,
          meta: { code: err.code, requestId: err.requestId },
        };
      }
      return { message: err.message, meta: { code: err.code, requestId: err.requestId } };
    }
    // Network failure (offline, DNS, etc.) — fetch throws TypeError
    if (err instanceof TypeError && err.message.toLowerCase().includes("fetch")) {
      return {
        message: "Network error. Check your connection and try again.",
        meta: null,
      };
    }
    return { message: "Something went wrong. Please try again.", meta: null };
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setErrorMeta(null);
    if (countdownRef.current) clearInterval(countdownRef.current);
    setRetryCountdown(null);

    // Basic client-side validation to avoid unnecessary 422 round-trips
    if (!identifier.trim() || !password) {
      setError("Please enter your email/registration number and password.");
      return;
    }

    setLoading(true);
    try {
      await api("/api/auth/login", { method: "POST", json: { identifier: identifier.trim(), password } });
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      const { message, meta } = formatError(err);
      setError(message);
      setErrorMeta(meta);
      if (meta?.retryAfter && meta.retryAfter > 0 && meta.retryAfter < 120) {
        startRetryCountdown(meta.retryAfter);
      }
      // Auto-retry once for transient 503 (e.g. pool timeout on cold start) after a short delay,
      // but only if we haven't already retried via countdown — user can also manually retry.
    } finally {
      setLoading(false);
    }
  }

  const isRateLimited = errorMeta?.code === undefined && retryCountdown !== null || (errorMeta?.retryAfter !== undefined && retryCountdown !== null);
  const isTransient = errorMeta?.code === "SERVICE_UNAVAILABLE" || errorMeta?.code === "SCHEMA_OUTDATED";

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
      <h1 className="text-2xl font-extrabold text-white tracking-tight">Welcome back</h1>
      <p className="text-sm text-zinc-400 mt-1.5 mb-8">Sign in to your XeroxEase account.</p>

      {notice && (
        <div
          role="status"
          aria-live="polite"
          className="mb-6 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3.5 text-sm text-emerald-200"
        >
          {notice}
        </div>
      )}

      <form onSubmit={onSubmit} className="space-y-5" noValidate>
        <div>
          <Label htmlFor="identifier" required>Email or Registration Number</Label>
          <Input
            id="identifier"
            autoComplete="username"
            placeholder="you@college.edu or RA2211..."
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            required
            disabled={loading}
          />
        </div>
        <div>
          <div className="flex items-center justify-between">
            <Label htmlFor="password" required>Password</Label>
            <Link href="/forgot-password" className="text-xs text-[#b49aff] hover:text-[#7c5cff] transition-colors mb-1.5">
              Forgot password? Use your recovery code
            </Link>
          </div>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            disabled={loading}
          />
        </div>
        {error && (
          <div
            role="alert"
            aria-live="assertive"
            className={`rounded-xl border p-3.5 text-sm ${
              isTransient
                ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                : "border-red-500/30 bg-red-500/10 text-red-200"
            }`}
          >
            <p>{error}</p>
            {retryCountdown !== null && (
              <p className="mt-2 text-xs opacity-80">You can retry in {retryCountdown}s.</p>
            )}
            {errorMeta?.requestId && (
              <p className="mt-2 text-xs opacity-60 font-mono break-all">Ref: {errorMeta.requestId}</p>
            )}
            {isTransient && !retryCountdown && (
              <p className="mt-2 text-xs opacity-80">This is usually temporary — please try again.</p>
            )}
          </div>
        )}
        {/* Fallback to old FieldError for compatibility if needed */}
        {!error && <FieldError message={undefined} />}
        <Button type="submit" className="w-full" size="lg" loading={loading} disabled={loading || retryCountdown !== null}>
          {retryCountdown !== null ? `Try again in ${retryCountdown}s` : "Sign in"}
        </Button>
      </form>

      <p className="text-sm text-zinc-400 mt-8 text-center">
        New to XeroxEase?{" "}
        <Link href="/register" className="text-[#b49aff] font-semibold hover:text-[#7c5cff] transition-colors">
          Create an account
        </Link>
      </p>
      <p className="text-xs text-zinc-600 mt-4 text-center">
        Administrator?{" "}
        <Link href="/admin/login" className="underline hover:text-zinc-400 transition-colors">
          Sign in here
        </Link>
      </p>

      <div className="mt-6 border-t border-white/10 pt-3 flex justify-center">
        <SupportContact />
      </div>
    </motion.div>
  );
}
