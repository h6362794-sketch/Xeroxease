"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Detailed diagnostics go to the console (server logs in production).
    console.error("[app-error]", error);
  }, [error]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 text-center">
      <div className="rounded-2xl bg-red-500/10 p-4 mb-5">
        <svg className="h-8 w-8 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
        </svg>
      </div>
      <h1 className="text-xl font-bold text-white">Something went wrong. Please try again.</h1>
      <p className="text-sm text-zinc-400 mt-2 max-w-sm">
        The issue has been logged. If it persists, contact the print desk.
      </p>
      <Button className="mt-8" onClick={reset}>Try again</Button>
    </div>
  );
}
