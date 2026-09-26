"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { Button, Input, Label, FieldError, Select } from "@/components/ui";
import { api, ApiError } from "@/lib/api-client";

const BRANCHES = ["CSE", "ECE", "EEE", "MECH", "CIVIL", "IT", "AI&DS", "Other"];

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    regNo: "",
    branch: "CSE",
    section: "A",
    year: "1",
    password: "",
    confirmPassword: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (form.password !== form.confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      await api("/api/auth/register", {
        method: "POST",
        json: { ...form, year: Number(form.year) },
      });
      router.push("/login?registered=1");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
      <h1 className="text-2xl font-extrabold text-white tracking-tight">Create your account</h1>
      <p className="text-sm text-zinc-400 mt-1.5 mb-8">Start printing in under a minute.</p>

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div>
          <Label htmlFor="name" required>Full Name</Label>
          <Input id="name" value={form.name} onChange={set("name")} placeholder="Aarav Sharma" required />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <Label htmlFor="email" required>Email</Label>
            <Input id="email" type="email" value={form.email} onChange={set("email")} placeholder="you@college.edu" required />
          </div>
          <div>
            <Label htmlFor="phone" required>Phone Number</Label>
            <Input id="phone" type="tel" value={form.phone} onChange={set("phone")} placeholder="9876543210" required />
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="col-span-2">
            <Label htmlFor="regNo" required>Registration Number</Label>
            <Input id="regNo" value={form.regNo} onChange={set("regNo")} placeholder="RA2211003010001" required />
          </div>
          <div>
            <Label htmlFor="branch" required>Branch</Label>
            <Select id="branch" value={form.branch} onChange={set("branch")}>
              {BRANCHES.map((b) => <option key={b}>{b}</option>)}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="section" required>Sec</Label>
              <Input id="section" value={form.section} onChange={set("section")} maxLength={4} required />
            </div>
            <div>
              <Label htmlFor="year" required>Year</Label>
              <Select id="year" value={form.year} onChange={set("year")}>
                {[1, 2, 3, 4, 5].map((y) => <option key={y} value={y}>{y}</option>)}
              </Select>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <Label htmlFor="password" required>Password</Label>
            <Input id="password" type="password" autoComplete="new-password" value={form.password} onChange={set("password")} required />
            <p className="text-[11px] text-zinc-500 mt-1">8+ chars with upper, lower & a number.</p>
          </div>
          <div>
            <Label htmlFor="confirmPassword" required>Confirm Password</Label>
            <Input id="confirmPassword" type="password" autoComplete="new-password" value={form.confirmPassword} onChange={set("confirmPassword")} required />
          </div>
        </div>
        <FieldError message={error ?? undefined} />
        <Button type="submit" className="w-full" size="lg" loading={loading}>
          Create account
        </Button>
      </form>

      <p className="text-sm text-zinc-400 mt-6 text-center">
        Already have an account?{" "}
        <Link href="/login" className="text-[#b49aff] font-semibold hover:text-[#7c5cff] transition-colors">
          Sign in
        </Link>
      </p>
    </motion.div>
  );
}
