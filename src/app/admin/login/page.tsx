"use client";

import { useState } from "react";
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
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api("/api/auth/admin-login", { method: "POST", json: { email, password } });
      router.push("/admin");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

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
              <Input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div>
              <Label htmlFor="password" required>Password</Label>
              <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            <FieldError message={error ?? undefined} />
            <Button type="submit" className="w-full" size="lg" loading={loading}>
              Sign in securely
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
