// Server-only environment access. Never import from client components.

const required = (key: string): string => {
  const v = process.env[key];
  if (!v) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return v;
};

export const env = {
  get DATABASE_URL() {
    return required("DATABASE_URL");
  },
  get SESSION_SECRET() {
    return required("SESSION_SECRET");
  },
  get SESSION_TTL_HOURS() {
    return Number(process.env.SESSION_TTL_HOURS || 24);
  },
  get APP_URL() {
    return process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  },
  get STORAGE_BACKEND(): "local" | "supabase" {
    return (process.env.STORAGE_BACKEND as "local" | "supabase") || "local";
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
} as const;
