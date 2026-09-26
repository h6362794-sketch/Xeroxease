import Link from "next/link";
import { LogoMark } from "@/components/logo";

export default function NotFound() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 text-center">
      <LogoMark size={56} className="mb-6" />
      <p className="text-6xl font-extrabold brand-gradient-text">404</p>
      <h1 className="text-xl font-bold text-white mt-4">This page jammed in the feeder.</h1>
      <p className="text-sm text-zinc-400 mt-2 max-w-sm">The page you&apos;re looking for doesn&apos;t exist or was moved.</p>
      <Link href="/" className="btn-brand mt-8 inline-flex rounded-xl px-6 py-3 text-sm font-semibold">
        Back to home
      </Link>
    </div>
  );
}
