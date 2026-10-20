// Access rule for documents attached to an order.
//
// A client supplies only order/file ids; authorization is derived entirely from
// database rows. An administrator may read a document only when:
//   * the actor has an administrative role,
//   * the order exists,
//   * the file row is attached to THAT order (not merely guessed),
//   * the file was uploaded by the order's owner,
//   * the upload was verified (status COMPLETED) and has a storage key.
//
// The same "not found" answer is returned for every negative case so the endpoint
// cannot be used as an existence oracle for another student's documents.

export interface OrderFileRow {
  id: string;
  orderId: string | null;
  uploaderId: string;
  status: string;
  storageKey: string | null;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface OrderOwnerRow {
  id: string;
  userId: string;
}

export type OrderFileDecision =
  | { allowed: true }
  | { allowed: false; reason: "forbidden" | "missing" | "unverified" };

export function authorizeAdminOrderFile(input: {
  file: OrderFileRow | null;
  order: OrderOwnerRow | null;
  actorRole: string;
}): OrderFileDecision {
  const { file, order, actorRole } = input;
  if (actorRole !== "ADMIN" && actorRole !== "SUPER_ADMIN") return { allowed: false, reason: "forbidden" };
  if (!file || !order) return { allowed: false, reason: "missing" };
  if (file.orderId !== order.id) return { allowed: false, reason: "missing" };
  if (file.uploaderId !== order.userId) return { allowed: false, reason: "forbidden" };
  if (file.status !== "COMPLETED" || !file.storageKey) return { allowed: false, reason: "unverified" };
  return { allowed: true };
}

/**
 * Header value for a safe download. The filename is derived from the stored
 * original name, never from a request path, and CR/LF/quotes are stripped so it
 * cannot inject headers or break the quoted-string. RFC 5987 `filename*` carries
 * non-ASCII names; an ASCII fallback keeps old clients working.
 */
export function safeContentDisposition(filename: string, mode: "view" | "download"): string {
  const cleaned = filename
    .replace(/[\r\n"\\]/g, "_")
    .replace(/[/\\?%*:|<>]/g, "_")
    .slice(0, 180)
    .trim();
  const fallback = (cleaned || "document").replace(/[^\x20-\x7e]/g, "_");
  const type = mode === "view" ? "inline" : "attachment";
  // encodeURIComponent leaves a few characters ( ' ( ) * ) that RFC 5987 does not
  // allow in ext-value, so escape them explicitly.
  const encoded = encodeURIComponent(cleaned || "document").replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
