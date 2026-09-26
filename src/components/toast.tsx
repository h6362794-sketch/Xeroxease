"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, XCircle, Info } from "lucide-react";

type Toast = { msg: string; kind: "success" | "error" | "info" } | null;

const ToastCtx = createContext<(msg: string, kind?: Toast extends null ? never : "success" | "error" | "info") => void>(
  () => {}
);

export function useToast() {
  return useContext(ToastCtx);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast>(null);

  const show = useCallback((msg: string, kind: "success" | "error" | "info" = "info") => {
    setToast({ msg, kind });
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  return (
    <ToastCtx.Provider value={show}>
      {children}
      <AnimatePresence>
        {toast && (
          <motion.div
            role="status"
            aria-live="polite"
            className="fixed bottom-20 sm:bottom-6 left-1/2 -translate-x-1/2 z-[100] glass-strong rounded-xl px-4 py-3 flex items-center gap-2.5 shadow-2xl max-w-[92vw]"
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ duration: 0.18 }}
          >
            {toast.kind === "success" && <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0" />}
            {toast.kind === "error" && <XCircle className="h-5 w-5 text-red-400 shrink-0" />}
            {toast.kind === "info" && <Info className="h-5 w-5 text-sky-400 shrink-0" />}
            <p className="text-sm text-white">{toast.msg}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </ToastCtx.Provider>
  );
}
