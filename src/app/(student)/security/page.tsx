import Link from "next/link";
import { requirePageUser } from "@/server/auth";
import { getRecoveryCodeStatus } from "@/server/recovery";
import { RecoveryCodePanel } from "@/components/recovery-code-panel";
import { Card } from "@/components/ui";

export const dynamic = "force-dynamic";

export const metadata = { title: "Security · XeroxEase" };

export default async function SecurityPage() {
  const user = await requirePageUser();
  const status = await getRecoveryCodeStatus(user.id);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-white tracking-tight">Security</h1>
        <p className="text-sm text-zinc-400 mt-1">
          Account recovery for {user.email}
        </p>
      </div>

      <RecoveryCodePanel
        initial={{
          hasCode: status.hasCode,
          createdAt: status.createdAt?.toISOString() ?? null,
          expiresAt: status.expiresAt?.toISOString() ?? null,
          usedAt: status.usedAt?.toISOString() ?? null,
          issuedByAdmin: status.issuedByAdmin,
        }}
      />

      <Card className="space-y-3">
        <h2 className="text-base font-bold text-white">How recovery works</h2>
        <ul className="space-y-2 text-sm text-zinc-400 list-disc pl-5 leading-relaxed">
          <li>
            XeroxEase never emails passwords or reset links. Recovery uses a code that only you hold.
          </li>
          <li>
            A recovery code works together with your email or registration number, and only once. After you use
            it, generate a new one here.
          </li>
          <li>
            If you lose your password and your code, visit the counter: an administrator can verify your identity
            in person and issue you a temporary code. They cannot see or set your password.
          </li>
        </ul>
      </Card>

      <p className="text-center text-sm">
        <Link href="/profile" className="text-[#b49aff] hover:text-[#7c5cff] transition-colors">
          ← Back to profile
        </Link>
      </p>
    </div>
  );
}
