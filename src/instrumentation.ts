import type { Instrumentation } from "next";
import { describeSchemaSkew } from "@/server/schema-skew";

/** Next calls this on the server, including for failed RSC renders. Never log
 * request headers, URLs/query strings, error messages or Prisma query parameters:
 * those may contain credentials or student data. Next's digest joins this event
 * to the generic browser error. Stack frames retain operator-useful locations.
 */
export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  const diagnostic = error instanceof Error ? error as Error & { digest?: string; code?: string } : undefined;
  const code = diagnostic && "code" in diagnostic && typeof diagnostic.code === "string" && /^P\d{4}$/.test(diagnostic.code)
    ? diagnostic.code : undefined;
  // A stack can itself contain message continuation lines starting with "at",
  // function display names, eval text or URL query strings. Retain only ordinary
  // JS/TS file locations, not arbitrary lines that happen to start with "at".
  // V8 repeats the complete (possibly multiline) message before its frames.
  // Strip that exact prefix first: a message can forge a syntactically valid
  // "at /path/file.js:1:2" line. Unknown stack formats are omitted, not guessed.
  const heading = diagnostic?.message ? `${diagnostic.name}: ${diagnostic.message}` : diagnostic?.name;
  const trace = heading && diagnostic?.stack?.startsWith(heading)
    ? diagnostic.stack.slice(heading.length) : undefined;
  const frames = trace?.split("\n").flatMap((line) => {
    const location = line.match(/^\s+at (?:[^()\n]* \()?((?:\/|[A-Za-z]:[\\/])[A-Za-z0-9_./()[\]@ \\-]+\.(?:[cm]?js|tsx?)):(\d+):(\d+)\)?$/);
    return location ? [`    at ${location[1]}:${location[2]}:${location[3]}`] : [];
  }).slice(0, 40);
  const digest = typeof diagnostic?.digest === "string" && /^\d{1,20}$/.test(diagnostic.digest)
    ? diagnostic.digest : undefined;
  // Platform correlation ID only; never accept arbitrary header content in logs.
  const headerId = request.headers["x-vercel-id"];
  const requestId = typeof headerId === "string" && /^[a-zA-Z0-9:._-]{1,160}$/.test(headerId)
    ? headerId : undefined;
  // Schema-version skew ("the deploy is newer than the database") is the failure mode
  // behind the 2026-10-20 /dashboard incident. `code` alone reports P2022; the missing
  // *object* is what identifies the unapplied migration, and it was the one fact the
  // operator could not recover from a digest. describeSchemaSkew is pure, total, and
  // returns allowlisted schema identifiers only — never message text, SQL parameters or
  // row data. Wrapped defensively regardless: diagnostics must never become the
  // incident.
  let schemaSkew: ReturnType<typeof describeSchemaSkew>;
  try {
    schemaSkew = describeSchemaSkew(error);
  } catch {
    schemaSkew = undefined;
  }
  console.error("[server-request-error]", JSON.stringify({
    requestId,
    timestamp: new Date().toISOString(),
    digest,
    route: context.routePath,
    routeType: context.routeType,
    router: context.routerKind,
    method: request.method,
    code,
    schemaSkew,
    // Only V8 stack frames, not the message (which can include SQL/data).
    stack: frames?.join("\n"),
  }));
};
