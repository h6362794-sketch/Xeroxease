"use client";

import Link from "next/link";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Menu, X, LogIn } from "lucide-react";
import { Button } from "./ui";
import { LogoFull } from "./logo";

const LINKS = [
  { href: "/#how", label: "How it works" },
  { href: "/#features", label: "Features" },
  { href: "/#security", label: "Security" },
  { href: "/#faq", label: "FAQ" },
];

export function SiteNav() {
  const [open, setOpen] = useState(false);
  return (
    <header className="fixed top-0 inset-x-0 z-50">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="mt-3 glass-strong rounded-2xl px-4 sm:px-5 h-16 flex items-center justify-between">
          <Link href="/" aria-label="XeroxEase home" className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60 rounded-xl">
            <LogoFull size={38} />
          </Link>
          <nav className="hidden md:flex items-center gap-6" aria-label="Main">
            {LINKS.map((l) => (
              <a key={l.href} href={l.href} className="text-sm text-zinc-300 hover:text-white transition-colors">
                {l.label}
              </a>
            ))}
          </nav>
          <div className="hidden md:flex items-center gap-2">
            <Link href="/admin/login" className="text-sm text-zinc-400 hover:text-white transition-colors px-3">
              Admin
            </Link>
            <Link href="/login">
              <Button size="sm" icon={<LogIn className="h-4 w-4" />}>
                Sign in
              </Button>
            </Link>
          </div>
          <button
            className="md:hidden rounded-lg p-2 text-zinc-300 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label="Toggle menu"
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>
      <AnimatePresence>
        {open && (
          <motion.div
            className="md:hidden mx-4 mt-2 glass-strong rounded-2xl p-4 space-y-1"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.16 }}
          >
            {LINKS.map((l) => (
              <a key={l.href} href={l.href} onClick={() => setOpen(false)} className="block rounded-lg px-3 py-2.5 text-sm text-zinc-200 hover:bg-white/10">
                {l.label}
              </a>
            ))}
            <div className="flex gap-2 pt-2 border-t border-white/10">
              <Link href="/login" className="flex-1">
                <Button size="sm" className="w-full">
                  Sign in
                </Button>
              </Link>
              <Link href="/admin/login" className="flex-1">
                <Button size="sm" variant="ghost" className="w-full">
                  Admin
                </Button>
              </Link>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
