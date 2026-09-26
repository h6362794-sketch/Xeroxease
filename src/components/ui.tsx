"use client";

import { forwardRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes, type ReactNode, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Loader2, Star, X, AlertTriangle, Inbox } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------- Button ----------

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "brand" | "ghost" | "outline" | "danger" | "success";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  icon?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "brand", size = "md", loading, icon, children, disabled, ...props },
  ref
) {
  const base = "inline-flex items-center justify-center gap-2 font-semibold rounded-xl transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#08080a] disabled:opacity-50 disabled:pointer-events-none select-none";
  const sizes = { sm: "text-xs px-3 py-1.5", md: "text-sm px-4 py-2.5", lg: "text-base px-6 py-3" };
  const variants = {
    brand: "btn-brand",
    ghost: "btn-ghost",
    outline: "border border-[rgba(255,255,255,0.2)] text-white hover:bg-white/5 active:scale-[0.97] transition-all",
    danger: "bg-red-600/90 text-white hover:bg-red-600 active:scale-[0.97] transition-all",
    success: "bg-emerald-600/90 text-white hover:bg-emerald-600 active:scale-[0.97] transition-all",
  };
  return (
    <button
      ref={ref}
      className={cn(base, sizes[size], variants[variant], className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

// ---------- Inputs ----------

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref
) {
  return <input ref={ref} className={cn("input", className)} {...props} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...props },
  ref
) {
  return (
    <select ref={ref} className={cn("input appearance-none cursor-pointer", className)} {...props}>
      {children}
    </select>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...props },
  ref
) {
  return <textarea ref={ref} className={cn("input min-h-[90px] resize-y", className)} {...props} />;
});

export function Label({ children, htmlFor, required }: { children: ReactNode; htmlFor?: string; required?: boolean }) {
  return (
    <label htmlFor={htmlFor} className="block text-sm font-medium text-zinc-300 mb-1.5">
      {children} {required && <span className="text-[#7c5cff]">*</span>}
    </label>
  );
}

export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-xs text-red-400 mt-1.5">
      {message}
    </p>
  );
}

// ---------- Badge ----------

export function Badge({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold tracking-wide", className)}>
      {children}
    </span>
  );
}

// ---------- Card ----------

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("card p-5", className)}>{children}</div>;
}

export function SectionTitle({ children, sub }: { children: ReactNode; sub?: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-lg font-bold text-white">{children}</h2>
      {sub && <p className="text-sm text-zinc-400 mt-0.5">{sub}</p>}
    </div>
  );
}

// ---------- Skeleton ----------

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton h-4 w-full", className)} aria-hidden="true" />;
}

// ---------- States ----------

export function EmptyState({ title, sub, icon }: { title: string; sub?: string; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-14 text-center">
      <div className="mb-4 rounded-2xl bg-white/5 p-4 text-zinc-400">{icon ?? <Inbox className="h-8 w-8" />}</div>
      <p className="font-semibold text-white">{title}</p>
      {sub && <p className="text-sm text-zinc-400 mt-1 max-w-sm">{sub}</p>}
    </div>
  );
}

export function ErrorState({ title, sub, onRetry }: { title: string; sub?: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-14 text-center">
      <div className="mb-4 rounded-2xl bg-red-500/10 p-4 text-red-400">
        <AlertTriangle className="h-8 w-8" />
      </div>
      <p className="font-semibold text-white">{title}</p>
      {sub && <p className="text-sm text-zinc-400 mt-1 max-w-sm">{sub}</p>}
      {onRetry && (
        <Button variant="ghost" size="sm" className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("h-5 w-5 animate-spin text-zinc-400", className)} />;
}

// ---------- Rating ----------

export function RatingInput({ value, onChange, size = 28 }: { value: number; onChange: (v: number) => void; size?: number }) {
  const [hover, setHover] = useState(0);
  return (
    <div className="flex gap-1" role="radiogroup" aria-label="Rating">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} star${n > 1 ? "s" : ""}`}
          className="transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60 rounded"
          onMouseEnter={() => setHover(n)}
          onMouseLeave={() => setHover(0)}
          onClick={() => onChange(n)}
        >
          <Star
            style={{ width: size, height: size }}
            className={(hover || value) >= n ? "fill-amber-400 text-amber-400" : "text-zinc-600"}
          />
        </button>
      ))}
    </div>
  );
}

export function StarDisplay({ rating, size = 14 }: { rating: number; size?: number }) {
  return (
    <div className="flex gap-0.5" aria-label={`${rating} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} style={{ width: size, height: size }} className={n <= Math.round(rating) ? "fill-amber-400 text-amber-400" : "text-zinc-700"} />
      ))}
    </div>
  );
}

// ---------- Modal / Confirm ----------

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    if (open) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[90] flex items-end sm:items-center justify-center p-0 sm:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className={cn("relative w-full glass-strong rounded-t-2xl sm:rounded-2xl p-5 max-h-[88vh] overflow-y-auto", wide ? "sm:max-w-2xl" : "sm:max-w-md")}
            initial={{ y: 40, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 30, opacity: 0, scale: 0.98 }}
            transition={{ type: "spring", damping: 26, stiffness: 300 }}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-white">{title}</h3>
              <button onClick={onClose} aria-label="Close dialog" className="rounded-lg p-1.5 text-zinc-400 hover:bg-white/10 hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7c5cff]/60">
                <X className="h-4 w-4" />
              </button>
            </div>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = "Confirm",
  danger,
  loading,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <p className="text-sm text-zinc-300">{message}</p>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button variant={danger ? "danger" : "brand"} size="sm" onClick={onConfirm} loading={loading}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

// ---------- Toast ----------

export function useToastState() {
  const [toast, setToast] = useState<{ msg: string; kind: "success" | "error" | "info" } | null>(null);
  return { toast, setToast };
}
