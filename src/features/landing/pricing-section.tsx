"use client";

import { useEffect, useState } from "react";
import { Reveal } from "./landing-interactive";
import { formatCurrencyINR } from "@/lib/utils";
import { Skeleton } from "@/components/ui";

interface PublicPrice {
  key: string;
  label: string;
  category: string;
  unit: string;
  unitPrice: number;
}

/**
 * Landing-page rates come from the same active PricingConfig the order engine
 * uses — no hard-coded price list that can silently drift after an admin update.
 */
export function PricingSection() {
  const [rows, setRows] = useState<PublicPrice[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/pricing", { headers: { accept: "application/json" } })
      .then((r) => {
        if (!r.ok) throw new Error("pricing unavailable");
        return r.json() as Promise<{ pricing: PublicPrice[] }>;
      })
      .then((data) => {
        if (!cancelled) setRows(data.pricing);
      })
      .catch(() => {
        if (!cancelled) {
          setRows([]);
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section id="pricing-section" className="mx-auto max-w-6xl px-4 sm:px-6 py-24">
      <div className="max-w-2xl mb-14">
        <p className="text-xs uppercase tracking-[0.25em] text-[#b49aff] font-semibold mb-3">Pricing</p>
        <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">Student-friendly rates.</h2>
        <p className="mt-3 text-sm text-zinc-400">
          Live rates from the print desk. Your final amount is calculated on the server from verified pages and shown before you order.
        </p>
      </div>
      <Reveal>
        {rows === null ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-busy="true" aria-label="Loading current prices">
            {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}
          </div>
        ) : rows.length === 0 ? (
          <div className="card p-6 text-sm text-zinc-400">
            {failed
              ? "Current rates could not be loaded. Please check back shortly or ask the print desk."
              : "Pricing is being configured. Please ask the print desk for current rates."}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {rows.map((p, i) => (
              <div key={p.key} className={`card p-5 ${i === 0 ? "glow-ring" : ""}`}>
                <p className="text-sm text-zinc-400 break-words">{p.label}</p>
                <p className="mt-2 text-2xl font-extrabold text-white">
                  {formatCurrencyINR(p.unitPrice)}
                  <span className="text-sm text-zinc-500 font-medium">{p.unit === "page" ? "/page" : "/item"}</span>
                </p>
              </div>
            ))}
          </div>
        )}
      </Reveal>
    </section>
  );
}
