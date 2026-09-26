import Link from "next/link";
import { LogoFull } from "@/components/logo";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen grid lg:grid-cols-2">
      {/* Brand panel */}
      <div className="relative hidden lg:flex flex-col justify-between p-12 bg-gradient-to-br from-[#171338] via-[#0d0b20] to-[#08080f] overflow-hidden">
        <div className="aurora opacity-70" aria-hidden="true" />
        <div className="absolute inset-0 grid-pattern" aria-hidden="true" />
        <div className="absolute -top-32 -right-32 h-96 w-96 rounded-full bg-[#7c5cff]/25 blur-3xl" aria-hidden="true" />
        <div className="absolute -bottom-40 -left-24 h-80 w-80 rounded-full bg-[#4338ca]/25 blur-3xl" aria-hidden="true" />
        <Link href="/" className="relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60 rounded-xl w-fit">
          <LogoFull size={46} />
        </Link>
        <div className="relative">
          <h1 className="text-4xl font-extrabold tracking-tight text-white leading-tight max-w-md">
            Skip the queue.<br />
            <span className="brand-gradient-text">Print from anywhere.</span>
          </h1>
          <p className="mt-4 text-zinc-400 max-w-md leading-relaxed">
            Upload, pay via QR, and collect — XeroxEase keeps your documents moving while you keep studying.
          </p>
        </div>
        <p className="relative text-xs text-zinc-600">© {new Date().getFullYear()} XeroxEase — Efficient Document Solutions</p>
      </div>
      {/* Form panel */}
      <div className="flex flex-col min-h-screen">
        <div className="lg:hidden p-5">
          <Link href="/" className="inline-block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60 rounded-xl">
            <LogoFull size={38} />
          </Link>
        </div>
        <div className="flex-1 flex items-center justify-center p-5 sm:p-8">
          <div className="w-full max-w-md">{children}</div>
        </div>
      </div>
    </div>
  );
}
