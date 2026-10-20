// Core application constants & design tokens (TS side)

export const BRAND = {
  name: "XeroxEase",
  tagline: "Efficient Document Solutions",
  description:
    "Upload, print, and collect documents effortlessly. AI page detection, secure QR payments, live order tracking — printing made effortless for students.",
};

export const SESSION_COOKIE = "xe_session";
export const CSRF_COOKIE = "xe_csrf";

export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MiB (52,428,800 bytes) per file — Supabase Free-tier compatible
export const MAX_FILES_PER_ORDER = 10;

export const ALLOWED_UPLOAD_TYPES = ["pdf", "doc", "docx", "ppt", "pptx"] as const;
export type AllowedUploadType = (typeof ALLOWED_UPLOAD_TYPES)[number];

export const PAPER_SIZES = ["A4", "LEGAL"] as const;
export const COLOR_MODES = ["BW", "COLOR"] as const;
export const PRINT_SIDES = ["SINGLE", "DOUBLE"] as const;
export const FINISHING_OPTIONS = ["STAPLE", "SPIRAL", "STICK_FILE"] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];
export type ColorMode = (typeof COLOR_MODES)[number];
export type PrintSide = (typeof PRINT_SIDES)[number];
export type FinishingOption = (typeof FINISHING_OPTIONS)[number];

// The authoritative order-status model lives in `./order-status` so the API,
// admin portal and student portal cannot drift apart. Re-exported here for the
// many existing imports of `@/lib/constants`.
export {
  ORDER_TRANSITIONS,
  CANCELLABLE_STATUSES,
  ORDER_STATUS_VALUES,
  STUDENT_STAGES,
} from "./order-status";

import { ORDER_STATUS_VALUES } from "./order-status";

/** Every status the admin status endpoint accepts (canonical + legacy). */
export const PUBLIC_STATUSES = ORDER_STATUS_VALUES;

/** Visible timeline stages (canonical names; the timeline component maps legacy). */
export const TRACKING_STEPS = [
  "ORDER_RECEIVED",
  "ACCEPTED",
  "PRINTING",
  "READY_FOR_PICKUP",
  "DELIVERED",
] as const;

/** Payment choices, validated server-side. */
export const PAYMENT_METHODS = ["CASH_ON_DELIVERY", "UPI"] as const;
export type PaymentMethodValue = (typeof PAYMENT_METHODS)[number];

export const RETENTION_DAYS_DEFAULT = 30;
