// Public support/helpline configuration.
//
// The number is read from `NEXT_PUBLIC_SUPPORT_PHONE` (public, non-secret; inlined
// at build time). No number is invented here: when it is absent or malformed the
// UI renders a graceful, non-clickable fallback rather than a broken `tel:` link.

export interface SupportPhone {
  /** Normalised digits with an optional leading +, safe for a tel: URI. */
  tel: string;
  /** Human-friendly display value. */
  display: string;
}

/**
 * Accept common written forms (`+91 98765-43210`, `(040) 1234 5678`) while
 * rejecting anything that is not a plausible phone number. The stored value is
 * never HTML — it is rendered as text by React.
 */
export function normalizeSupportPhone(raw: string | null | undefined): SupportPhone | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Only digits, spaces, dashes, parentheses, dots and one optional leading +.
  if (!/^\+?[0-9()\-.\s]+$/.test(trimmed)) return null;
  const plus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  // E.164 allows 7–15 digits. Shorter strings are not dialable numbers.
  if (digits.length < 7 || digits.length > 15) return null;
  // Reject a lone zero / obvious placeholders.
  if (/^0+$/.test(digits) || /^1+$/.test(digits)) return null;

  const tel = `${plus ? "+" : ""}${digits}`;
  return { tel, display: formatPhone(digits, plus) };
}

function formatPhone(digits: string, plus: boolean): string {
  // Simple, locale-neutral grouping; never guesses a country code.
  if (digits.length === 10) return `${plus ? "+" : ""}${digits.slice(0, 5)} ${digits.slice(5)}`;
  if (digits.length === 12 && digits.startsWith("91")) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  return `${plus ? "+" : ""}${digits}`;
}

/** The `href` for a phone link, or null when unusable. */
export function supportTelHref(raw: string | null | undefined): string | null {
  const phone = normalizeSupportPhone(raw);
  return phone ? `tel:${phone.tel}` : null;
}
