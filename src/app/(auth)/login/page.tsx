"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { Button, Input, Label, FieldError } from "@/components/ui";
import { api, ApiError } from "@/lib/api-client";

export default function LoginPage() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api("/api/auth/login", { method: "POST", json: { identifier, password } });
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
      <h1 className="text-2xl font-extrabold text-white tracking-tight">Welcome back</h1>
      <p className="text-sm text-zinc-400 mt-1.5 mb-8">Sign in to your XeroxEase account.</p>

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
          />
        </div>
        <div>
          <div className="flex items-center justify-between">
            <Label htmlFor="password" required>Password</Label>
            <Link href="/forgot-password" className="text-xs text-[#b49aff] hover:text-[#7c5cff] transition-colors mb-1.5">
              Forgot password?
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
          />
        </div>
        <FieldError message={error ?? undefined} />
        <Button type="submit" className="w-full" size="lg" loading={loading}>
          Sign in
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
    </motion.div>
  );
}
