import Link from "next/link";
import { LogoFull } from "./logo";

export function SiteFooter() {
  return (
    <footer className="border-t border-white/10 mt-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-12">
        <div className="grid gap-10 md:grid-cols-4">
          <div className="md:col-span-2">
            <LogoFull size={42} />
            <p className="text-sm text-zinc-400 mt-4 max-w-sm">
              Upload, print, and collect documents effortlessly. Built for students who value their time.
            </p>
          </div>
          <div>
            <p className="text-sm font-semibold text-white mb-3">Product</p>
            <ul className="space-y-2 text-sm text-zinc-400">
              <li><a href="/#how" className="hover:text-white transition-colors">How it works</a></li>
              <li><a href="/#pricing-section" className="hover:text-white transition-colors">Pricing</a></li>
              <li><a href="/#faq" className="hover:text-white transition-colors">FAQ</a></li>
            </ul>
          </div>
          <div>
            <p className="text-sm font-semibold text-white mb-3">Legal</p>
            <ul className="space-y-2 text-sm text-zinc-400">
              <li><Link href="/privacy" className="hover:text-white transition-colors">Privacy Policy</Link></li>
              <li><Link href="/terms" className="hover:text-white transition-colors">Terms of Service</Link></li>
            </ul>
          </div>
        </div>
        <div className="mt-10 pt-6 border-t border-white/5 flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-xs text-zinc-500">© {new Date().getFullYear()} XeroxEase. All rights reserved.</p>
          <p className="text-xs text-zinc-500">Printing made effortless.</p>
        </div>
      </div>
    </footer>
  );
}
