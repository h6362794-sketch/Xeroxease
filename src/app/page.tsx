import Link from "next/link";
import { SiteNav } from "@/components/site-nav";
import { SiteFooter } from "@/components/site-footer";
import { IntroGate } from "@/components/intro-gate";
import { HeroStagger, HeroItem, Reveal } from "@/features/landing/landing-interactive";
import {
  UploadCloud,
  ScanSearch,
  SlidersHorizontal,
  QrCode,
  MapPin,
  Star,
  ShieldCheck,
  Zap,
  FileCheck2,
  BellRing,
  ChevronDown,
  Printer,
  ArrowRight,
  Lock,
} from "lucide-react";

export default function LandingPage() {
  return (
    <IntroGate>
      <SiteNav />
      <main>
        <Hero />
        <HowItWorks />
        <Features />
        <Security />
        <PricingSection />
        <Faq />
        <FinalCta />
      </main>
      <SiteFooter />
    </IntroGate>
  );
}

function Hero() {
  return (
    <section className="relative min-h-[100svh] flex items-center hero-vignette overflow-hidden">
      <div className="aurora" aria-hidden="true" />
      <div className="absolute inset-0 grid-pattern" aria-hidden="true" />
      <FloatingDocs />
      <div className="relative mx-auto max-w-6xl px-4 sm:px-6 pt-32 pb-20 w-full">
        <div className="max-w-2xl">
          <HeroStagger>
            <p className="text-xs uppercase tracking-[0.3em] text-[#b49aff] font-semibold mb-4">
              For students who value their time
            </p>
            <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight leading-[1.05]">
              <span className="text-gradient">Printing made</span>
              <br />
              <span className="brand-gradient-text">effortless.</span>
            </h1>
            <p className="mt-6 text-base sm:text-lg text-zinc-400 leading-relaxed max-w-xl">
              Upload your documents, let AI count the pages, pay securely with any UPI QR scanner,
              and track your order live — from our printer to your hands.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href="/register"
                className="btn-brand inline-flex items-center gap-2 rounded-xl px-6 py-3 text-base font-semibold"
              >
                Start Printing <ArrowRight className="h-4 w-4" />
              </Link>
              <a
                href="#how"
                className="btn-ghost inline-flex items-center gap-2 rounded-xl px-6 py-3 text-base font-semibold"
              >
                How It Works
              </a>
            </div>
            <div className="mt-10 flex flex-wrap gap-x-8 gap-y-3 text-sm text-zinc-400">
              <span className="inline-flex items-center gap-2"><Zap className="h-4 w-4 text-[#b49aff]" /> AI page detection</span>
              <span className="inline-flex items-center gap-2"><QrCode className="h-4 w-4 text-[#b49aff]" /> UPI QR payments</span>
              <span className="inline-flex items-center gap-2"><BellRing className="h-4 w-4 text-[#b49aff]" /> Live order tracking</span>
            </div>
          </HeroStagger>
        </div>
      </div>
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 text-zinc-600 animate-bounce" aria-hidden="true">
        <ChevronDown className="h-5 w-5" />
      </div>
    </section>
  );
}

function FloatingDocs() {
  const docs = [
    { top: "18%", left: "68%", rot: "-8deg", delay: "0s", size: "w-24 h-32" },
    { top: "30%", left: "82%", rot: "10deg", delay: "1.2s", size: "w-20 h-28" },
    { top: "58%", left: "72%", rot: "6deg", delay: "0.6s", size: "w-28 h-20" },
    { top: "70%", left: "85%", rot: "-12deg", delay: "1.8s", size: "w-16 h-24" },
  ];
  return (
    <div className="hidden lg:block absolute inset-0 pointer-events-none" aria-hidden="true">
      {docs.map((d, i) => (
        <div
          key={i}
          className={`absolute ${d.size} glass rounded-xl animate-float`}
          style={{ top: d.top, left: d.left, transform: `rotate(${d.rot})`, animationDelay: d.delay }}
        >
          <div className="p-3 space-y-2 opacity-60">
            <div className="h-1.5 w-3/4 rounded bg-white/25" />
            <div className="h-1.5 w-1/2 rounded bg-white/15" />
            <div className="h-1.5 w-2/3 rounded bg-white/15" />
            <div className="h-8 rounded bg-[#7c5cff]/20 mt-3" />
          </div>
        </div>
      ))}
      <div className="absolute top-[42%] right-[6%] glass rounded-2xl p-4 animate-float" style={{ animationDelay: "2.2s" }}>
        <Printer className="h-8 w-8 text-[#b49aff]" />
      </div>
    </div>
  );
}

const STEPS = [
  { icon: UploadCloud, title: "Upload Documents", text: "PDF, DOC, DOCX, PPT, PPTX up to 100 MB each. Drag, drop, done — from your phone or laptop." },
  { icon: ScanSearch, title: "AI Page Detection", text: "Our document engine counts pages automatically before you pay. No surprises at the counter." },
  { icon: SlidersHorizontal, title: "Customize Printing", text: "A4 or Legal, B&W or colour, single or double side, copies, custom page ranges, stapling and binding." },
  { icon: QrCode, title: "Pay via QR", text: "Scan the print desk's UPI QR with any payment app. Submit the reference — we verify it quickly." },
  { icon: MapPin, title: "Track & Collect", text: "Watch your order move through printing and quality check in real time. Show your collection QR and walk away." },
];

function HowItWorks() {
  return (
    <section id="how" className="mx-auto max-w-6xl px-4 sm:px-6 py-24">
      <div className="max-w-2xl mb-14">
        <p className="text-xs uppercase tracking-[0.25em] text-[#b49aff] font-semibold mb-3">How XeroxEase works</p>
        <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
          From your hostel room to the print desk — without the walk.
        </h2>
      </div>
      <Reveal>
        <ol className="grid gap-6 md:grid-cols-5">
          {STEPS.map((s, i) => (
            <li key={s.title} className="card p-5 hover:border-[#7c5cff]/40 transition-colors group relative overflow-hidden">
              <span className="absolute -top-3 -right-1 text-[64px] font-extrabold text-white/5 select-none" aria-hidden="true">
                {i + 1}
              </span>
              <s.icon className="h-7 w-7 text-[#b49aff] mb-4" />
              <h3 className="font-bold text-white mb-2">{s.title}</h3>
              <p className="text-sm text-zinc-400 leading-relaxed">{s.text}</p>
            </li>
          ))}
        </ol>
      </Reveal>
    </section>
  );
}

const FEATURES = [
  { icon: Zap, title: "Lightning fast orders", text: "A 60-second order flow tuned for thumbs. Reorder past configurations in two taps." },
  { icon: FileCheck2, title: "Verified page counts", text: "Server-side document parsing. The price you see is computed from verified pages — never guessed." },
  { icon: QrCode, title: "QR-native payments", text: "No cards, no gateways. Scan, pay, submit the reference. The desk confirms in minutes." },
  { icon: BellRing, title: "Live notifications", text: "In-app updates at every stage — payment confirmed, printing started, order ready." },
  { icon: Star, title: "Rate your experience", text: "Star ratings and feedback after collection. We read every single one." },
  { icon: ShieldCheck, title: "Private by design", text: "Documents live in private storage behind authorization checks — never public URLs." },
];

function Features() {
  return (
    <section id="features" className="mx-auto max-w-6xl px-4 sm:px-6 py-24">
      <div className="max-w-2xl mb-14">
        <p className="text-xs uppercase tracking-[0.25em] text-[#b49aff] font-semibold mb-3">Features</p>
        <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
          Everything a print shop should be. Nothing it shouldn&apos;t.
        </h2>
      </div>
      <Reveal>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="card p-6 hover:-translate-y-1 hover:border-[#7c5cff]/40 transition-all duration-300">
              <f.icon className="h-6 w-6 text-[#b49aff] mb-4" />
              <h3 className="font-bold text-white mb-2">{f.title}</h3>
              <p className="text-sm text-zinc-400 leading-relaxed">{f.text}</p>
            </div>
          ))}
        </div>
      </Reveal>
    </section>
  );
}

function Security() {
  return (
    <section id="security" className="mx-auto max-w-6xl px-4 sm:px-6 py-24">
      <div className="card p-8 sm:p-12 relative overflow-hidden">
        <div className="absolute -top-20 -right-20 h-72 w-72 rounded-full bg-[#7c5cff]/10 blur-3xl" aria-hidden="true" />
        <div className="grid gap-10 md:grid-cols-2 items-center relative">
          <div>
            <p className="text-xs uppercase tracking-[0.25em] text-[#b49aff] font-semibold mb-3">Security</p>
            <h2 className="text-3xl font-extrabold tracking-tight text-white mb-4">Your documents stay yours.</h2>
            <p className="text-zinc-400 leading-relaxed mb-6">
              Every upload passes signature and type validation before touching storage. Files are
              served only to their owners over authorized, private endpoints — with role-based access
              control, rate limiting, and full audit logs behind the scenes.
            </p>
            <ul className="space-y-3 text-sm text-zinc-300">
              {[
                "Private storage — no public file URLs, ever",
                "Server-verified pricing and page counts",
                "Admin-verified payments with audit trail",
                "Rate-limited, brute-force-resistant authentication",
              ].map((t) => (
                <li key={t} className="flex items-center gap-3">
                  <Lock className="h-4 w-4 text-emerald-400 shrink-0" /> {t}
                </li>
              ))}
            </ul>
          </div>
          <div className="flex justify-center">
            <div className="glass-strong rounded-3xl p-8 max-w-xs w-full text-center">
              <ShieldCheck className="h-12 w-12 text-emerald-400 mx-auto mb-4" />
              <p className="font-bold text-white">Defense in depth</p>
              <p className="text-sm text-zinc-400 mt-2">
                Built on OWASP guidance: strict validation, least privilege, immutable audit logging.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

const PRICING_ROWS = [
  { label: "A4 Black & White", price: "₹2", unit: "/page" },
  { label: "A4 Colour", price: "₹8", unit: "/page" },
  { label: "Legal Black & White", price: "₹3", unit: "/page" },
  { label: "Legal Colour", price: "₹10", unit: "/page" },
  { label: "Staple", price: "₹5", unit: "" },
  { label: "Spiral Binding", price: "₹40", unit: "" },
  { label: "Stick File", price: "₹25", unit: "" },
];

function PricingSection() {
  return (
    <section id="pricing-section" className="mx-auto max-w-6xl px-4 sm:px-6 py-24">
      <div className="max-w-2xl mb-14">
        <p className="text-xs uppercase tracking-[0.25em] text-[#b49aff] font-semibold mb-3">Pricing</p>
        <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">Student-friendly rates.</h2>
      </div>
      <Reveal>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PRICING_ROWS.map((p, i) => (
            <div key={p.label} className={`card p-5 ${i === 0 ? "glow-ring" : ""}`}>
              <p className="text-sm text-zinc-400">{p.label}</p>
              <p className="mt-2 text-2xl font-extrabold text-white">
                {p.price}
                <span className="text-sm text-zinc-500 font-medium">{p.unit}</span>
              </p>
            </div>
          ))}
        </div>
      </Reveal>
    </section>
  );
}

const FAQS = [
  { q: "Do I need to visit the print shop to place an order?", a: "No. Upload documents, configure printing, and pay via QR — all from your phone. You only visit to collect." },
  { q: "How is the page count decided?", a: "Our server-side document engine parses your files and detects pages automatically. If a format can't be parsed reliably, the print desk verifies it manually before printing." },
  { q: "How do payments work?", a: "Scan the print desk's UPI QR with any payment app, pay the exact amount, and submit the transaction reference. A human verifies it — no payment gateway, no card details stored." },
  { q: "When can I cancel an order?", a: "While the order is awaiting payment or under payment review. Once printing begins, cancellation is disabled." },
  { q: "What happens to my documents afterwards?", a: "Files are retained for a limited, configurable period after completion and then purged. You can always download your invoice." },
  { q: "My document shows 'needs review'. What now?", a: "Some formats (like legacy .doc/.ppt) hide their page counts. The print desk verifies these manually — you'll see the confirmed count before paying." },
];

function Faq() {
  return (
    <section id="faq" className="mx-auto max-w-3xl px-4 sm:px-6 py-24">
      <div className="mb-14 text-center">
        <p className="text-xs uppercase tracking-[0.25em] text-[#b49aff] font-semibold mb-3">FAQ</p>
        <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">Questions, answered.</h2>
      </div>
      <Reveal>
        <div className="space-y-3">
          {FAQS.map((f) => (
            <details key={f.q} className="card px-5 py-4 group">
              <summary className="flex items-center justify-between cursor-pointer font-semibold text-white list-none">
                {f.q}
                <ChevronDown className="h-4 w-4 text-zinc-500 transition-transform group-open:rotate-180" />
              </summary>
              <p className="mt-3 text-sm text-zinc-400 leading-relaxed">{f.a}</p>
            </details>
          ))}
        </div>
      </Reveal>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="mx-auto max-w-6xl px-4 sm:px-6 pb-8">
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-[#7c5cff] via-[#6d4aff] to-[#4338ca] px-8 py-14 text-center shadow-glow">
        <div className="absolute inset-0 grid-pattern opacity-60" aria-hidden="true" />
        <div className="absolute -top-16 -left-16 h-56 w-56 rounded-full bg-white/15 blur-3xl" aria-hidden="true" />
        <div className="absolute -bottom-20 -right-12 h-64 w-64 rounded-full bg-[#a78bfa]/40 blur-3xl" aria-hidden="true" />
        <h2 className="relative text-3xl sm:text-4xl font-extrabold tracking-tight text-white drop-shadow-[0_2px_12px_rgba(0,0,0,0.25)]">Your next print run is 60 seconds away.</h2>
        <p className="relative mt-3 text-white/85 max-w-xl mx-auto">Join students who never queue at the print shop again.</p>
        <Link href="/register" className="cta-shine relative mt-8 inline-flex items-center gap-2 rounded-xl bg-white px-7 py-3 text-base font-bold text-[#5f3dff] hover:bg-violet-50 transition-colors">
          Create free account <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </section>
  );
}
