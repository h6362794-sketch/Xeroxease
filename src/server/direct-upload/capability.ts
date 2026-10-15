// Capability gate for the direct-to-storage upload protocol.
//
// The protocol is only implementable against a storage backend the browser can reach
// with a server-issued, scoped credential. That is Supabase Storage. The `local`
// backend has no such mechanism, so the honest answer is "not supported" plus a
// working alternative (the existing proxy route), not a silent fallback that would put
// document bytes through a function body.

import { env } from "@/server/env";
import { MAX_FILE_SIZE } from "@/lib/constants";

export type CapabilityReason = "DISABLED" | "BACKEND_UNSUPPORTED" | "SUPABASE_UNCONFIGURED";

/**
 * Raised when the *deployment* does not run this protocol, as opposed to the request
 * being wrong.
 *
 * It exists as a distinct type for one reason: `withErrorHandling` masks every 5xx into
 * a generic 500 so internal faults never leak. That is right for an infrastructure
 * failure and wrong here — a 501/503 capability answer is a documented, machine-readable
 * signal that lets the browser fall back to the proxy route. Routes catch this type and
 * answer with its real status and code; everything else keeps the masking behaviour.
 */
export class DeploymentCapabilityError extends Error {
  readonly status = 501;
  readonly code: CapabilityReason;
  constructor(reason: { code?: CapabilityReason; reason?: string }) {
    super(reason.reason ?? "Direct uploads are not available on this deployment.");
    this.name = "DeploymentCapabilityError";
    this.code = reason.code ?? "BACKEND_UNSUPPORTED";
  }
}

export interface DirectUploadCapability {
  enabled: boolean;
  code?: CapabilityReason;
  status?: number;
  reason?: string;
  maxBytes?: number;
  intentTtlSeconds?: number;
  /** Bytes per PUT: the whole file. Supabase signed uploads are not chunked. */
  resumable?: boolean;
  proxyUploadAvailable?: boolean;
  providerMaxBytes?: number;
}

/**
 * Why the error is 501 and not 500: a client that hits it on a `local` backend is not
 * looking at a fault, it is looking at an unsupported deployment shape. The browser
 * path (proxy upload) stays available in development, and production is refused by
 * `config:check` / the storage guard long before this would matter.
 */
export function directUploadsSupported(): {
  enabled: boolean;
  code?: CapabilityReason;
  status?: number;
  reason?: string;
} {
  if (!env.DIRECT_UPLOADS_ENABLED) {
    return {
      enabled: false,
      status: 503,
      code: "DISABLED",
      reason:
        "Direct uploads are disabled by configuration (DIRECT_UPLOADS_ENABLED=false). Uploads will go through the proxy route where the host's body limit allows it.",
    };
  }
  if (env.STORAGE_BACKEND !== "supabase") {
    return {
      enabled: false,
      status: 501,
      code: "BACKEND_UNSUPPORTED",
      reason:
        'Direct uploads require STORAGE_BACKEND=supabase: the "local" backend cannot hand the browser a scoped, time-limited storage credential. Use POST /api/uploads (proxy mode) for local development.',
    };
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return {
      enabled: false,
      status: 503,
      code: "SUPABASE_UNCONFIGURED",
      reason:
        "STORAGE_BACKEND=supabase but NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not configured. Uploads are refused rather than silently proxied.",
    };
  }
  return { enabled: true };
}

/** Public description of what the client may do. No secrets, no bucket names, no keys. */
export function describeUploadCapability(): DirectUploadCapability {
  const support = directUploadsSupported();
  const providerCap = env.STORAGE_PROVIDER_MAX_FILE_BYTES;
  const out: DirectUploadCapability = {
    enabled: support.enabled === true,
    maxBytes: MAX_FILE_SIZE,
    providerMaxBytes: providerCap > 0 ? Math.min(MAX_FILE_SIZE, providerCap) : MAX_FILE_SIZE,
    resumable: false,
    proxyUploadAvailable: env.STORAGE_BACKEND === "local",
    intentTtlSeconds: env.UPLOAD_INTENT_TTL_SECONDS,
  };
  // Only present when something is wrong, and only as a code plus a human sentence:
  // `code` is what the browser branches on (`chooseUploadMode`), `reason` is what it shows.
  if (support.code && support.reason) {
    out.code = support.code;
    out.reason = support.reason;
  }
  return out;
}
