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

// Legal status transitions for OrderStatus (server-enforced)
export const ORDER_TRANSITIONS: Record<string, string[]> = {
  ORDER_PLACED: ["PAYMENT_PENDING", "PAYMENT_UNDER_REVIEW", "PAYMENT_CONFIRMED", "CANCELLED", "FAILED"],
  PAYMENT_PENDING: ["PAYMENT_UNDER_REVIEW", "PAYMENT_CONFIRMED", "CANCELLED", "FAILED"],
  PAYMENT_UNDER_REVIEW: ["PAYMENT_CONFIRMED", "PAYMENT_PENDING", "CANCELLED", "FAILED"],
  PAYMENT_CONFIRMED: ["DOCUMENTS_RECEIVED", "PROCESSING", "PRINTING", "CANCELLED", "FAILED"],
  DOCUMENTS_RECEIVED: ["PROCESSING", "PRINTING", "CANCELLED", "FAILED"],
  PROCESSING: ["PRINTING", "QUALITY_CHECK", "CANCELLED", "FAILED"],
  PRINTING: ["QUALITY_CHECK", "READY_FOR_COLLECTION", "FAILED"],
  QUALITY_CHECK: ["READY_FOR_COLLECTION", "FAILED"],
  READY_FOR_COLLECTION: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  CANCELLED: [],
  FAILED: [],
};

export const CANCELLABLE_STATUSES = [
  "ORDER_PLACED",
  "PAYMENT_PENDING",
  "PAYMENT_UNDER_REVIEW",
  "PAYMENT_CONFIRMED",
  "DOCUMENTS_RECEIVED",
  "PROCESSING",
] as const;

export const PUBLIC_STATUSES = [
  "ORDER_PLACED",
  "PAYMENT_PENDING",
  "PAYMENT_UNDER_REVIEW",
  "PAYMENT_CONFIRMED",
  "DOCUMENTS_RECEIVED",
  "PROCESSING",
  "PRINTING",
  "QUALITY_CHECK",
  "READY_FOR_COLLECTION",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
] as const;

export const TRACKING_STEPS = [
  "ORDER_PLACED",
  "PAYMENT_CONFIRMED",
  "DOCUMENTS_RECEIVED",
  "PRINTING",
  "QUALITY_CHECK",
  "READY_FOR_COLLECTION",
  "COMPLETED",
] as const;

export const RETENTION_DAYS_DEFAULT = 30;
/**
 * How long a document may sit uploaded but not attached to an order before the cleanup job
 * deletes it. Students who abandon the wizard, or remove a file, lose the document after this.
 * Not configurable on purpose: it is a published promise (see the privacy notice).
 */
export const UNATTACHED_UPLOAD_TTL_HOURS = 24;
