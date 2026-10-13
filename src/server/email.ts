// Outbound email delivery.
//
// The app never needs a full SMTP stack: password-reset delivery is a single
// "send one message" call against an HTTPS email API (Resend-compatible). Keeping
// it to `fetch` avoids adding a mail dependency for one feature.
//
// Live delivery is DISABLED unless ENABLE_EMAIL_DELIVERY=true AND EMAIL_API_URL,
// EMAIL_API_KEY and EMAIL_FROM are all set. When it is disabled the reset flow
// still works end-to-end; the link is surfaced in development only (see
// /api/auth/forgot-password) and never in production.

import { env } from "./env";

export interface SendResult {
  delivered: boolean;
  /** Never contains the token itself — safe to log. */
  detail: string;
}

export function isEmailConfigured(): boolean {
  return Boolean(env.ENABLE_EMAIL_DELIVERY && env.EMAIL_API_URL && env.EMAIL_API_KEY && env.EMAIL_FROM);
}

export async function sendPasswordResetEmail(params: {
  to: string;
  resetUrl: string;
  expiresInMinutes: number;
}): Promise<SendResult> {
  if (!isEmailConfigured()) {
    return { delivered: false, detail: "email delivery not configured" };
  }

  const body = {
    from: env.EMAIL_FROM,
    to: [params.to],
    subject: "Reset your XeroxEase password",
    text: [
      "We received a request to reset your XeroxEase password.",
      "",
      `Open this link within ${params.expiresInMinutes} minutes to choose a new password:`,
      params.resetUrl,
      "",
      "If you did not request this, you can safely ignore this email — your password will not change.",
    ].join("\n"),
    html: [
      "<p>We received a request to reset your XeroxEase password.</p>",
      `<p><a href="${escapeHtml(params.resetUrl)}">Choose a new password</a> — this link expires in ${params.expiresInMinutes} minutes.</p>`,
      "<p>If you did not request this, you can safely ignore this email; your password will not change.</p>",
    ].join(""),
  };

  try {
    const res = await fetch(env.EMAIL_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.EMAIL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 200);
      console.error("[email] provider rejected request", res.status, text);
      return { delivered: false, detail: `provider returned ${res.status}` };
    }
    return { delivered: true, detail: "sent" };
  } catch (err) {
    console.error("[email] delivery failed:", err instanceof Error ? err.message : err);
    return { delivered: false, detail: "provider unreachable" };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/** Absolute, app-owned reset URL. Only the app origin is ever used. */
export function buildResetUrl(token: string): string {
  const base = env.APP_URL.replace(/\/$/, "");
  return `${base}/reset-password?token=${encodeURIComponent(token)}`;
}
