"use client";

import { motion } from "framer-motion";
import { Check, X } from "lucide-react";
import { TRACKING_STEPS } from "@/lib/constants";
import { cn } from "@/lib/utils";

const LABELS: Record<string, string> = {
  ORDER_PLACED: "Order Placed",
  PAYMENT_CONFIRMED: "Payment Confirmed",
  DOCUMENTS_RECEIVED: "Documents Received",
  PRINTING: "Printing",
  QUALITY_CHECK: "Quality Check",
  READY_FOR_COLLECTION: "Ready for Collection",
  COMPLETED: "Completed",
};

/** Maps granular statuses onto the visible timeline. */
function stepIndexFor(status: string): number {
  switch (status) {
    case "ORDER_PLACED":
    case "PAYMENT_PENDING":
    case "PAYMENT_UNDER_REVIEW":
      return 0;
    case "PAYMENT_CONFIRMED":
      return 1;
    case "DOCUMENTS_RECEIVED":
    case "PROCESSING":
      return 2;
    case "PRINTING":
      return 3;
    case "QUALITY_CHECK":
      return 4;
    case "READY_FOR_COLLECTION":
      return 5;
    case "COMPLETED":
      return 6;
    default:
      return 0;
  }
}

export function OrderTimeline({ status }: { status: string }) {
  const failed = status === "CANCELLED" || status === "FAILED";
  const activeIdx = stepIndexFor(status);

  if (failed) {
    return (
      <div className="glass rounded-2xl p-5 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-red-500/15">
          <X className="h-6 w-6 text-red-400" />
        </div>
        <p className="font-semibold text-white">{status === "CANCELLED" ? "Order Cancelled" : "Order Failed"}</p>
        <p className="text-sm text-zinc-400 mt-1">This order is no longer active. Contact the print desk for help.</p>
      </div>
    );
  }

  return (
    <ol className="relative space-y-0" aria-label="Order progress">
      {TRACKING_STEPS.map((step, i) => {
        const done = i < activeIdx;
        const active = i === activeIdx;
        const isLast = i === TRACKING_STEPS.length - 1;
        return (
          <li key={step} className="relative flex gap-4 pb-6 last:pb-0">
            {!isLast && (
              <span
                className={cn("absolute left-[15px] top-8 h-[calc(100%-32px)] w-0.5 rounded", done ? "bg-emerald-400/70" : "bg-white/10")}
                aria-hidden="true"
              />
            )}
            <span className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border">
              {done && (
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/90">
                  <Check className="h-4 w-4 text-white" />
                </span>
              )}
              {active && (
                <motion.span
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-[#7c5cff]"
                  animate={{ boxShadow: ["0 0 0 0 rgba(124,92,255,0.45)", "0 0 0 8px rgba(124,92,255,0)"] }}
                  transition={{ repeat: Infinity, duration: 1.6, ease: "easeOut" }}
                >
                  <span className="h-2.5 w-2.5 rounded-full bg-white" />
                </motion.span>
              )}
              {!done && !active && <span className="h-2.5 w-2.5 rounded-full bg-zinc-600" />}
            </span>
            <div className="pt-1">
              <p className={cn("text-sm font-semibold", done || active ? "text-white" : "text-zinc-500")}>
                {LABELS[step]}
              </p>
              {active && (
                <motion.p
                  className="text-xs text-[#b49aff] mt-0.5"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: [0.6, 1, 0.6] }}
                  transition={{ repeat: Infinity, duration: 2 }}
                >
                  In progress…
                </motion.p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
