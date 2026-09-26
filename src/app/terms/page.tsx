import type { Metadata } from "next";
import { SiteNav } from "@/components/site-nav";
import { SiteFooter } from "@/components/site-footer";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "The terms that govern your use of XeroxEase.",
};

const SECTIONS = [
  {
    h: "Using XeroxEase",
    p: [
      "XeroxEase is a document-printing service for registered students. You must provide accurate registration details.",
      "You may only upload documents you have the right to print. Copyrighted material must be permitted for personal academic use.",
    ],
  },
  {
    h: "Orders & pricing",
    p: [
      "Prices are set by the print desk and calculated server-side from verified page counts — the displayed estimate is indicative.",
      "Once printing has begun, orders can no longer be cancelled.",
      "Collection requires the order collection code issued in the app.",
    ],
  },
  {
    h: "Payments",
    p: [
      "Payments are made by scanning the print desk's QR code with your payment app and submitting the transaction reference.",
      "An order is processed only after the desk verifies the payment. Submitting false payment information is grounds for account suspension.",
    ],
  },
  {
    h: "Content & conduct",
    p: [
      "Uploading malicious files, attempting to access other users' documents, or abusing the service may result in permanent suspension.",
      "We log privileged administrative actions in an immutable audit trail for your protection.",
    ],
  },
  {
    h: "Liability",
    p: [
      "XeroxEase is provided \"as is.\" While we take care with every document, our liability is limited to reprinting or refunding the order amount.",
    ],
  },
];

export default function TermsPage() {
  return (
    <>
      <SiteNav />
      <main className="mx-auto max-w-3xl px-4 sm:px-6 pt-32 pb-16">
        <h1 className="text-3xl font-extrabold text-white tracking-tight">Terms of Service</h1>
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
