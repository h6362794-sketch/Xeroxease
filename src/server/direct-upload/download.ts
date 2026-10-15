// Download policy: who may read a stored document, and how it reaches them.
//
// Two rules matter here.
//
//  1. Authorization is decided from the database row (owner or admin), never from the
//     object key. A client supplies only a document id; it cannot name a key, so a
//     guessed or borrowed key is not an input to the decision at all.
//  2. On the `supabase` backend the bytes must not pass through this function — a
//     100 MB response body is impossible on a platform that caps response bodies at
//     4.5 MB. So the route answers with a 307 to a *short-lived, object-specific*
//     signed URL and never touches the payload. `local` cannot sign, so it keeps
//     serving through the existing stream path (development only).

import { env } from "@/server/env";
import { canAccessFile, type DownloadMode } from "./policy";

/** The columns `/api/files/:id/download` needs, and nothing more. */
export interface DownloadSubject {
  id: string;
  uploaderId: string;
  originalName: string;
  storageKey: string | null;
  /** Row value only: the stored object's own type header is never trusted for a download. */
  mimeType: string;
  status: string;
}

export interface DownloadActor {
  id: string;
  role: string;
}

export const NOT_FOUND_MESSAGE = "File not found.";

/**
 * One decision for one row. `file === null` (missing) and `!allowed` (not yours) must
 * produce the *same* caller-visible answer, otherwise the endpoint becomes an oracle
 * for "does this other user's document exist?".
 */
export function authorizeDownload(
  file: DownloadSubject | null,
  actor: DownloadActor,
  isAdminRole: (role: string) => boolean
): { allowed: false } | { allowed: true; file: DownloadSubject } {
  if (!file) return { allowed: false };
  if (!canAccessFile(file, actor, isAdminRole)) return { allowed: false };
  return { allowed: true, file };
}

/** Whether this response may be answered by handing the browser a storage URL. */
export function shouldSignDownload(): boolean {
  return env.STORAGE_BACKEND === "supabase";
}

/** TTL for the signed URL, so the route and its tests read one value. */
export function signedDownloadTtlSeconds(): number {
  return env.SIGNED_DOWNLOAD_URL_TTL_SECONDS;
}

/**
 * Cache discipline for a redirect that embeds a credential in its `Location`.
 *
 * A shared cache or browser that stored this response would hand the signed URL to the
 * next requester of the same path, which is exactly the leak the redirect must avoid.
 * The private/no-store/no-cache triad is belt-and-braces across intermediaries.
 */
export function downloadRedirectHeaders(): Record<string, string> {
  return {
    "Cache-Control": "private, no-store, max-age=0, must-revalidate",
    Pragma: "no-cache",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
  };
}

/** `download` is the conservative default: never rely on the CDN honouring inline. */
export function dispositionFor(mode: DownloadMode): boolean {
  return mode !== "view";
}
