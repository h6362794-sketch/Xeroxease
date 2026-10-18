"use client";

import { useEffect, useState } from "react";
import { Check, Copy, ShieldCheck } from "lucide-react";
import { Button, Card, FieldError, Input, Label } from "@/components/ui";
import { api, ApiError } from "@/lib/api-client";
import { formatCurrencyINR } from "@/lib/utils";

export interface PaymentQr {
  enabled: boolean;
  qrUrl?: string;
  instructions: string;
  accountDisplay: string;
}

/** Minimum length accepted by the form. The server applies the full rules (see payment-reference.ts). */
export const MIN_REFERENCE_LENGTH = 4;

/**
 * The payment step, shared by the order wizard and the order page.
 *
 * It is the only place a student submits a reference. Both entry points post to the same
 * endpoint, so the server's state guard and duplicate-reference check apply identically whether
 * the student pays right after ordering or comes back later after a rejection.
 */
export function PaymentForm({
  orderId,
  orderNumber,
  totalAmount,
  rejectionReason = null,
  onSubmitted,
  onLater,
}: {
  orderId: string;
  orderNumber: string;
  totalAmount: number;
  /** The desk's reason for rejecting the previous reference, when there is one. */
  rejectionReason?: string | null;
  onSubmitted: () => void;
  /** When given, shows a "pay later" escape hatch (used by the wizard). */
  onLater?: () => void;
}) {
  const [qr, setQr] = useState<PaymentQr | null>(null);
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api<PaymentQr>("/api/payment/qr")
      .then(setQr)
      .catch(() =>
        setQr({ enabled: false, instructions: "Contact the print desk for payment.", accountDisplay: "XeroxEase Print Desk" })
      );
  }, []);

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      await api(`/api/payment/submit/${orderId}`, { method: "POST", json: { reference } });
      onSubmitted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not submit the payment reference. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-5">
      {rejectionReason !== null && (
        <div className="flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 p-4" role="alert">
          <ShieldCheck className="h-5 w-5 text-red-300 shrink-0 mt-0.5" />
          <div className="text-sm text-red-200 space-y-1">
            <p className="font-semibold">The print desk could not accept your last payment reference.</p>
            <p>Reason: {rejectionReason || "No reason was given."}</p>
            <p className="text-red-200/80">Check the reference in your payment app and submit it again.</p>
          </div>
        </div>
      )}

      <Card className="text-center space-y-4">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-zinc-500 font-semibold">Amount to pay</p>
          <p className="text-3xl font-extrabold text-white mt-1">{formatCurrencyINR(totalAmount)}</p>
          <p className="text-xs text-zinc-500 mt-1">Order {orderNumber}</p>
        </div>
        {qr?.enabled && qr.qrUrl ? (
          <div className="mx-auto w-fit rounded-2xl bg-white p-3 shadow-glow">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr.qrUrl} alt="Payment QR code" className="h-52 w-52 object-contain" />
          </div>
        ) : (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
            The payment QR is not configured yet. Please pay at the desk or check back shortly.
          </div>
        )}
        <p className="text-xs text-zinc-400 leading-relaxed max-w-sm mx-auto">{qr?.instructions}</p>
        <p className="text-xs text-zinc-500">{qr?.accountDisplay}</p>
      </Card>

      <Card className="space-y-4">
        <div>
          <Label htmlFor="ref" required>Transaction reference / UTR</Label>
          <div className="flex gap-2">
            <Input
              id="ref"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="e.g. 402512345678"
              autoComplete="off"
            />
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                navigator.clipboard.writeText(orderNumber);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              icon={copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            >
              Copy order no.
            </Button>
          </div>
          <p className="text-[11px] text-zinc-500 mt-1.5">Found in your payment app&apos;s transaction history.</p>
        </div>
        {error && <FieldError message={error} />}
        <Button
          className="w-full"
          size="lg"
          onClick={submit}
          loading={submitting}
          disabled={reference.trim().length < MIN_REFERENCE_LENGTH || submitting}
        >
          I&apos;ve paid — submit for verification
        </Button>
        <p className="text-[11px] text-zinc-500 text-center">
          Payments are verified by the print desk. You&apos;ll be notified when confirmed — usually within minutes during working hours.
        </p>
        {onLater && (
          <button onClick={onLater} className="text-xs text-zinc-500 hover:text-zinc-300 underline mx-auto block">
            I&apos;ll pay later — go to my order
          </button>
        )}
      </Card>
    </div>
  );
}
