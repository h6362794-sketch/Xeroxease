"use client";

import { Check, X, Clock } from "lucide-react";
import { STUDENT_STAGES, stageIndexFor, statusLabel } from "@/lib/order-status";
import { cn, formatDate } from "@/lib/utils";

export interface TimelineEvent {
  id?: string;
  type: string;
  toStatus: string | null;
  fromStatus?: string | null;
  message?: string | null;
  createdAt: string | Date;
}

/**
 * Student-facing progress timeline, shared by student and admin views.
 *
 * The five stages come from the authoritative status model. Legacy statuses fold
 * into the same stages, so historical orders remain readable without rewriting
 * them. Rejection/cancellation are shown as a distinct outcome, never as a
 * progress step.
 */
export function OrderTimeline({
  status,
  events = [],
  rejectionReason,
}: {
  status: string;
  events?: TimelineEvent[];
  rejectionReason?: string | null;
}) {
  const outcome =
    status === "REJECTED" || status === "CANCELLED" || status === "FAILED" ? status : null;

  if (outcome) {
    return (
      <div className="glass rounded-2xl p-5 text-center" role="status">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-red-500/15">
          <X className="h-6 w-6 text-red-400" aria-hidden="true" />
        </div>
        <p className="font-semibold text-white">
          {outcome === "REJECTED"
            ? "Order Not Accepted"
            : outcome === "CANCELLED"
            ? "Order Cancelled"
            : "Order Failed"}
        </p>
        <p className="text-sm text-zinc-400 mt-1">
          {outcome === "REJECTED"
            ? "The print desk declined this order."
            : "This order is no longer active. Contact the print desk for help."}
        </p>
        {rejectionReason && (
          <p className="mt-2 text-sm text-red-200/90 break-words">
            <span className="font-semibold">Reason:</span> {rejectionReason}
          </p>
        )}
      </div>
    );
  }

  const activeIdx = stageIndexFor(status);
  const delivered = status === "DELIVERED" || status === "COMPLETED";

  return (
    <ol className="relative space-y-0" aria-label="Order progress">
      {STUDENT_STAGES.map((stage, i) => {
        const done = delivered || (activeIdx >= 0 && i < activeIdx);
        const active = !delivered && i === activeIdx;
        const isLast = i === STUDENT_STAGES.length - 1;
        const reachedEvent = [...events]
          .reverse()
          .find((e) => e.toStatus && stage.statuses.includes(e.toStatus));

        return (
          <li key={stage.key} className="relative flex gap-3 pb-6 last:pb-0" aria-current={active ? "step" : undefined}>
            {!isLast && (
              <span
                className={cn(
                  "absolute left-[15px] top-8 h-[calc(100%-32px)] w-0.5 rounded",
                  done ? "bg-emerald-400/70" : "bg-white/10"
                )}
                aria-hidden="true"
              />
            )}
            <span className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/10">
              {done ? (
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/90">
                  <Check className="h-4 w-4 text-white" aria-hidden="true" />
                </span>
              ) : active ? (
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#7c5cff] ring-4 ring-[#7c5cff]/20">
                  <span className="h-2.5 w-2.5 rounded-full bg-white" />
                </span>
              ) : (
                <span className="h-2.5 w-2.5 rounded-full bg-zinc-600" />
              )}
            </span>
            <div className="min-w-0 pt-1">
              <p className={cn("text-sm font-semibold", done || active ? "text-white" : "text-zinc-500")}>
                {stage.label}
                <span className="sr-only">
                  {done ? " — completed" : active ? " — current stage" : " — upcoming"}
                </span>
              </p>
              <p className={cn("text-xs mt-0.5", active ? "text-[#b49aff]" : "text-zinc-500")}>
                {active ? stage.description : done ? "Completed" : "Pending"}
              </p>
              {reachedEvent?.createdAt && (done || active) && (
                <p className="text-[11px] text-zinc-500 mt-0.5 flex items-center gap-1">
                  <Clock className="h-3 w-3" aria-hidden="true" />
                  {formatDate(reachedEvent.createdAt)}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Compact single-line progress label for order cards. */
export function statusProgressLabel(status: string): string {
  if (["REJECTED", "CANCELLED", "FAILED"].includes(status)) return statusLabel(status);
  const index = stageIndexFor(status);
  return index >= 0 ? `${STUDENT_STAGES[index].label} · step ${index + 1} of ${STUDENT_STAGES.length}` : statusLabel(status);
}
