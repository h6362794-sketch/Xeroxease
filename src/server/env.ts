// Server-only environment access. Never import from client components.

const required = (key: string): string => {
  const v = process.env[key];
  if (!v) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return v;
};

const num = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${key} must be a number, got "${raw}"`);
  }
  return parsed;
};

const bool = (key: string, fallback = false): boolean => {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
};

export const env = {
  get DATABASE_URL() {
    return required("DATABASE_URL");
  },
  get SESSION_SECRET() {
    const v = required("SESSION_SECRET");
    if (v.length < 32) {
      throw new Error(
        "SESSION_SECRET must be at least 32 characters. Generate one with: openssl rand -base64 32"
      );
    }
    return v;
  },
  get SESSION_TTL_HOURS() {
    return num("SESSION_TTL_HOURS", 24);
  },
  get APP_URL() {
    return process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  },
  get STORAGE_BACKEND(): string {
    return process.env.STORAGE_BACKEND || "local";
  },
  get STORAGE_BUCKET() {
    return process.env.STORAGE_BUCKET || "documents";
  },
  get LOCAL_STORAGE_DIR() {
    return process.env.LOCAL_STORAGE_DIR || ".data/uploads";
  },
  get SUPABASE_URL() {
    return process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  },
  get SUPABASE_ANON_KEY() {
    return process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  },
  get SUPABASE_SERVICE_ROLE_KEY() {
    return process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  },
  /**
   * Number of reverse proxies in front of the app whose `X-Forwarded-For` entries
   * may be trusted. `getClientIp` reads the address that many hops from the right,
   * so anything an attacker prepends is ignored.
   *
   * 1 = one trusted proxy (Vercel, nginx, Cloudflare) -- the common case.
   * 0 = app is directly exposed to the internet: ignore XFF entirely, because a
   *     client can forge it to bypass per-IP rate limits.
   */
  get TRUSTED_PROXY_COUNT() {
    const raw = num("TRUSTED_PROXY_COUNT", 1);
    return Math.max(0, Math.min(10, Math.floor(raw)));
  },

  // ---------- Direct-to-storage uploads ----------
  /**
   * Master switch for the direct upload protocol (signed upload URL issued by the
   * server, bytes sent browser → storage, server verifies afterwards). It is only
   * implementable against a storage backend the browser can reach with a scoped
   * credential, i.e. `supabase`; the `local` backend has no such mechanism and every
   * direct-upload endpoint returns a clear 501 when it is selected.
   */
  get DIRECT_UPLOADS_ENABLED() {
    const raw = process.env.DIRECT_UPLOADS_ENABLED;
    // Default on: the 50 MB upload path is otherwise impossible on function hosts
    // with a request-body cap. Set to "false" only as an incident kill-switch.
    return raw === undefined || raw === "" ? true : bool("DIRECT_UPLOADS_ENABLED", true);
  },
  /** How long a signed upload intent stays completable. 60 s – 1 h. */
  get UPLOAD_INTENT_TTL_SECONDS() {
    const v = num("UPLOAD_INTENT_TTL_SECONDS", 600);
    if (v < 60 || v > 3600) {
      throw new Error("UPLOAD_INTENT_TTL_SECONDS must be between 60 and 3600 seconds");
    }
    return v;
  },
  /** Lifetime of the short-lived signed download URLs. 10 s – 15 min. */
  get SIGNED_DOWNLOAD_URL_TTL_SECONDS() {
    const v = num("SIGNED_DOWNLOAD_URL_TTL_SECONDS", 60);
    if (v < 10 || v > 900) {
      throw new Error("SIGNED_DOWNLOAD_URL_TTL_SECONDS must be between 10 and 900 seconds");
    }
    return v;
  },
  /**
   * The provider's own per-file cap, if lower than the application limit (50 MiB).
   * Supabase Free enforces a global 50 MB file limit that no application code can raise,
   * so this value should mirror the provider's cap. `0`/unset means "the app limit is
   * the binding one".
   */
  get STORAGE_PROVIDER_MAX_FILE_BYTES() {
    const v = num("STORAGE_PROVIDER_MAX_FILE_BYTES", 0);
    if (v < 0) throw new Error("STORAGE_PROVIDER_MAX_FILE_BYTES must not be negative");
    return v;
  },

  // ---------- Shared rate limiting ----------
  get RATE_LIMIT_STORAGE(): "memory" | "redis" {
    return process.env.RATE_LIMIT_STORAGE === "redis" ? "redis" : "memory";
  },
  get UPSTASH_REDIS_REST_URL() {
    return process.env.UPSTASH_REDIS_REST_URL || "";
  },
  get UPSTASH_REDIS_REST_TOKEN() {
    return process.env.UPSTASH_REDIS_REST_TOKEN || "";
  },
  get RATE_LIMIT_FAIL_OPEN() {
    return bool("RATE_LIMIT_FAIL_OPEN", false);
  },
} as const;
