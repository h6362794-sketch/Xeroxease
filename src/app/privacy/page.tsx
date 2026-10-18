import type { Metadata } from "next";
import { SiteNav } from "@/components/site-nav";
import { SiteFooter } from "@/components/site-footer";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How XeroxEase collects, uses, and protects your information.",
};

const SECTIONS = [
  {
    h: "What we collect",
    p: [
      "Account details you provide at registration: name, email, phone number, registration number, branch, section, and year.",
      "Documents you upload for printing, plus technical metadata (file size, type, page count).",
      "Payment references you submit for QR-based payments — we never collect card numbers, CVVs, UPI PINs, or banking credentials.",
      "Minimal usage data required to operate the service securely (e.g., audit logs of privileged actions).",
    ],
  },
  {
    h: "How we use it",
    p: [
      "To process your printing orders and let you track them.",
      "To verify payments you report via the QR workflow.",
      "To communicate order status through in-app notifications.",
      "To detect and prevent abuse, fraud, and security incidents.",
    ],
  },
  {
    h: "Document storage & retention",
    p: [
      "Uploaded documents are stored in private storage and are never publicly accessible. Access requires authentication and ownership.",
      "Documents you upload but never order are deleted automatically once they are more than 24 hours old. You can also remove an unordered document yourself at any time.",
      "Documents attached to an order are deleted after the retention period set by the print shop, which is 30 days by default. The clock starts when the order is completed, cancelled or failed. Deletion runs on a scheduled job, so it can happen some time after the deadline rather than at the exact moment.",
      "Order records, payment references, page counts and file names are kept for accounting after the document itself is deleted. A deleted document shows as removed on your order.",
    ],
  },
  {
    h: "Who can see your data",
    p: [
      "Only you, and authorized XeroxEase administrators for order fulfillment and payment verification.",
      "We do not sell or share your personal information with third parties.",
    ],
  },
  {
    h: "Your rights",
    p: [
      "You may request correction or deletion of your account data by contacting the print desk or support.",
      "You can cancel eligible orders at any time before printing begins.",
    ],
  },
];

export default function PrivacyPage() {
  return (
    <>
      <SiteNav />
      <main className="mx-auto max-w-3xl px-4 sm:px-6 pt-32 pb-16">
        <h1 className="text-3xl font-extrabold text-white tracking-tight">Privacy Policy</h1>
        <p className="text-sm text-zinc-500 mt-2">Last updated: September 2026</p>
        <div className="mt-10 space-y-8">
          {SECTIONS.map((s) => (
            <section key={s.h}>
              <h2 className="text-lg font-bold text-white mb-3">{s.h}</h2>
              <ul className="space-y-2">
                {s.p.map((t, i) => (
                  <li key={i} className="text-sm text-zinc-400 leading-relaxed flex gap-2">
                    <span className="text-[#b49aff] mt-1">·</span> {t}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
