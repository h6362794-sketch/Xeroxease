"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui";

/**
 * Route-scoped boundary for `/dashboard`.
 *
 * WHY A SCOPED ONE
 * The dashboard is the only page that reads orders on first paint, so it is where a
 * database problem surfaces first. The generic `src/app/error.tsx` cannot say which
 * section failed or which reference to quote; this one can, without telling the user
 * anything about the database.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   * It never renders `error.message`, `error.stack` or any server detail — those can
 *     carry SQL, connection strings or student records.
 *   * It never retries automatically. An automatic retry against a persistent failure
 *     (e.g. a database still missing a migration) is an unbounded loop that turns one
 *     error into a request storm.
 *   * It does not swallow the failure. The Server Component still throws, the request
 *     still fails on the server, and `src/instrumentation.ts` still records the
 *     exception with its Prisma/SQLSTATE code. Only the *presentation* is handled here.
 *
 * `reset()` is offered because it is the legitimate React recovery path for a
 * transient fault; it is a deliberate user action, never a loop.
 *
 * LOGGING
 * Next uses the nearest boundary, so this replaces — not duplicates — the parent's
 * `[app-error]` line for dashboard failures. It logs the digest only, which is the same
 * digest the server-side `[server-request-error]` record carries, so the two can be
 * joined without putting the message in the browser console.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[dashboard-error]", {
      digest: error.digest,
      pathname: "/dashboard",
      timestamp: new Date().toISOString(),
    });
  }, [error]);

  // Next digests are opaque numeric strings. Anything else is not echoed to the page.
  const reference =
    typeof error.digest === "string" && /^\d{1,20}$/.test(error.digest) ? error.digest : undefined;

  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center p-6 text-center">
      <div className="rounded-2xl bg-amber-500/10 p-4 mb-5">
        <svg
          className="h-8 w-8 text-amber-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.8}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
          />
        </svg>
      </div>

      <h1 className="text-xl font-bold text-white">We couldn&apos;t load your dashboard</h1>
      <p className="text-sm text-zinc-400 mt-2 max-w-sm">
        Your account is fine — this is a problem on our side. Please try again in a moment.
        If it keeps happening, ask at the print desk and quote the reference below.
      </p>

      {reference ? (
        <p className="mt-4 text-xs text-zinc-500">
          Reference:{" "}
          <span className="font-mono text-zinc-400 select-all" data-testid="error-reference">
            {reference}
          </span>
        </p>
      ) : null}

      <Button className="mt-8" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
