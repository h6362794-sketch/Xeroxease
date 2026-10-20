// Pure validation for the admin order lookup. Kept separate from the route so
// the bounds (query length, page size, date window) are unit-testable and cannot
// be bypassed by a crafted query string.

import { ORDER_STATUS_VALUES } from "./order-status";

export const ADMIN_ORDER_SEARCH_PAGE_SIZE = 20;
export const ADMIN_ORDER_SEARCH_MAX_PAGE_SIZE = 50;
export const ADMIN_ORDER_SEARCH_MAX_QUERY_LENGTH = 100;
export const ADMIN_ORDER_SEARCH_MAX_RANGE_DAYS = 730;

const PAYMENT_STATUSES = [
  "PAYMENT_PENDING",
  "PAYMENT_PROOF_SUBMITTED",
  "PAYMENT_UNDER_REVIEW",
  "PAYMENT_CONFIRMED",
  "PAYMENT_REJECTED",
  "PAYMENT_FAILED",
] as const;

export interface AdminOrderSearch {
  q: string;
  status: string | null;
  paymentStatus: string | null;
  from: Date | null;
  to: Date | null;
  page: number;
  pageSize: number;
}

export type AdminSearchParseResult =
  | { ok: true; value: AdminOrderSearch }
  | { ok: false; message: string };

function parseDate(raw: string | null, label: string): { ok: true; value: Date | null } | { ok: false; message: string } {
  if (!raw) return { ok: true, value: null };
  const trimmed = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return { ok: false, message: `${label} must be a date in YYYY-MM-DD format.` };
  }
  const date = new Date(`${trimmed}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return { ok: false, message: `${label} is not a valid date.` };
  // `new Date` rolls impossible days over (2026-02-31 becomes March 3), which
  // would silently widen the range. Require the date to round-trip exactly.
  if (date.toISOString().slice(0, 10) !== trimmed) {
    return { ok: false, message: `${label} is not a valid calendar date.` };
  }
  return { ok: true, value: date };
}

export function parseAdminOrderSearch(params: URLSearchParams): AdminSearchParseResult {
  const rawQ = params.get("q")?.trim() ?? "";
  if (rawQ.length > ADMIN_ORDER_SEARCH_MAX_QUERY_LENGTH) {
    return { ok: false, message: `Search text must be at most ${ADMIN_ORDER_SEARCH_MAX_QUERY_LENGTH} characters.` };
  }
  // Control characters are never meaningful in an order number/name/email and
  // make logs and UI output harder to reason about.
  if (/[\u0000-\u001f\u007f]/.test(rawQ)) {
    return { ok: false, message: "Search text contains unsupported characters." };
  }

  const rawStatus = params.get("status")?.trim() || "";
  const status = rawStatus && rawStatus !== "ALL" ? rawStatus : null;
  if (status && !ORDER_STATUS_VALUES.includes(status as never)) {
    return { ok: false, message: "Unknown order status filter." };
  }

  const rawPayment = params.get("paymentStatus")?.trim() || "";
  const paymentStatus = rawPayment && rawPayment !== "ALL" ? rawPayment : null;
  if (paymentStatus && !(PAYMENT_STATUSES as readonly string[]).includes(paymentStatus)) {
    return { ok: false, message: "Unknown payment status filter." };
  }

  const from = parseDate(params.get("from"), "Start date");
  if (!from.ok) return from;
  const to = parseDate(params.get("to"), "End date");
  if (!to.ok) return to;

  if (from.value && to.value) {
    if (from.value > to.value) return { ok: false, message: "Start date must be before the end date." };
    const days = (to.value.getTime() - from.value.getTime()) / 86_400_000;
    if (days > ADMIN_ORDER_SEARCH_MAX_RANGE_DAYS) {
      return { ok: false, message: `Date range may span at most ${ADMIN_ORDER_SEARCH_MAX_RANGE_DAYS} days.` };
    }
  }

  const pageRaw = parseInt(params.get("page") || "1", 10);
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.min(100_000, pageRaw)) : 1;
  const sizeRaw = parseInt(params.get("pageSize") || String(ADMIN_ORDER_SEARCH_PAGE_SIZE), 10);
  const pageSize = Number.isFinite(sizeRaw)
    ? Math.max(1, Math.min(ADMIN_ORDER_SEARCH_MAX_PAGE_SIZE, sizeRaw))
    : ADMIN_ORDER_SEARCH_PAGE_SIZE;

  return {
    ok: true,
    value: { q: rawQ, status, paymentStatus, from: from.value, to: to.value, page, pageSize },
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Build the Prisma `where` fragment. Every value is a bound parameter. */
export function adminOrderWhere(search: AdminOrderSearch): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  if (search.status) where.status = search.status;
  if (search.paymentStatus) where.paymentStatus = search.paymentStatus;

  if (search.from || search.to) {
    where.createdAt = {
      ...(search.from ? { gte: search.from } : {}),
      ...(search.to ? { lte: new Date(search.to.getTime() + 86_399_999) } : {}),
    };
  }

  if (search.q) {
    if (UUID_RE.test(search.q)) {
      where.OR = [
        { id: search.q },
        { orderNumber: { contains: search.q, mode: "insensitive" } },
        { user: { is: { OR: [
          { name: { contains: search.q, mode: "insensitive" } },
          { email: { contains: search.q, mode: "insensitive" } },
          { regNo: { contains: search.q, mode: "insensitive" } },
        ] } } },
      ];
    } else {
      where.OR = [
        { orderNumber: { contains: search.q, mode: "insensitive" } },
        {
          user: {
            is: {
              OR: [
                { name: { contains: search.q, mode: "insensitive" } },
                { email: { contains: search.q, mode: "insensitive" } },
                { regNo: { contains: search.q, mode: "insensitive" } },
              ],
            },
          },
        },
      ];
    }
  }

  return where;
}
