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
  // ---------- Email (password reset delivery) ----------
  get ENABLE_EMAIL_DELIVERY() {
    return bool("ENABLE_EMAIL_DELIVERY", false);
  },
  get EMAIL_API_URL() {
    return process.env.EMAIL_API_URL || "";
  },
  get EMAIL_API_KEY() {
    return process.env.EMAIL_API_KEY || "";
  },
  get EMAIL_FROM() {
    return process.env.EMAIL_FROM || "";
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
