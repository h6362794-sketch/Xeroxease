import Link from "next/link";
import { requirePageUser } from "@/server/auth";
import { prisma } from "@/lib/prisma";
import { Card } from "@/components/ui";
import { Mail, Phone, Hash, GraduationCap, KeyRound, LifeBuoy, ShieldCheck } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const session = await requirePageUser();
  const user = await prisma.user.findUnique({
    where: { id: session.id },
    select: { name: true, email: true, phone: true, regNo: true, branch: true, section: true, year: true, createdAt: true },
  });
  if (!user) return null;

  return (
    <div className="max-w-2xl mx-auto space-y-5">
      <h1 className="text-2xl font-extrabold text-white tracking-tight">Profile</h1>

      <Card className="space-y-4">
        <div className="flex items-center gap-4">
          <div className="h-14 w-14 rounded-2xl bg-[#7c5cff]/15 flex items-center justify-center text-xl font-extrabold text-[#b49aff]">
            {user.name.split(" ").map((p) => p[0]).slice(0, 2).join("")}
          </div>
          <div>
            <p className="font-bold text-white">{user.name}</p>
            <p className="text-xs text-zinc-500">Member since {new Date(user.createdAt).getFullYear()}</p>
          </div>
        </div>
        <div className="grid sm:grid-cols-2 gap-3 text-sm">
          <InfoRow icon={<Mail className="h-4 w-4" />} label="Email" value={user.email} />
          <InfoRow icon={<Phone className="h-4 w-4" />} label="Phone" value={user.phone ?? "—"} />
          <InfoRow icon={<Hash className="h-4 w-4" />} label="Registration No." value={user.regNo ?? "—"} />
          <InfoRow icon={<GraduationCap className="h-4 w-4" />} label="Class" value={`${user.branch ?? "—"} · Sec ${user.section ?? "—"} · Year ${user.year ?? "—"}`} />
        </div>
      </Card>

      <Card className="space-y-3">
        <h2 className="font-bold text-white">Account & support</h2>
        <Link href="/forgot-password" className="flex items-center gap-3 rounded-xl px-3 py-3 hover:bg-white/5 transition-colors text-sm text-zinc-200">
          <KeyRound className="h-4 w-4 text-zinc-500" /> Change password
        </Link>
        <a href="mailto:support@xeroxease.app" className="flex items-center gap-3 rounded-xl px-3 py-3 hover:bg-white/5 transition-colors text-sm text-zinc-200">
          <LifeBuoy className="h-4 w-4 text-zinc-500" /> Help & support
        </a>
        <Link href="/privacy" className="flex items-center gap-3 rounded-xl px-3 py-3 hover:bg-white/5 transition-colors text-sm text-zinc-200">
          <ShieldCheck className="h-4 w-4 text-zinc-500" /> Privacy & terms
        </Link>
      </Card>
    </div>
  );
}

function InfoRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-white/[0.03] px-3.5 py-3">
      <span className="text-zinc-500">{icon}</span>
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wider text-zinc-600 font-semibold">{label}</p>
        <p className="text-sm text-white truncate">{value}</p>
      </div>
    </div>
  );
}
