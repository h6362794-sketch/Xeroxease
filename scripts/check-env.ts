/* eslint-disable no-console */
/**
 * Pre-deployment configuration check.
 *
 * Fails with a non-zero exit code when required production configuration is
 * missing or obviously wrong, so a misconfigured deploy is caught before the app
 * serves traffic. It never prints secret values — only variable names.
 *
 * Usage: npm run config:check
 */

import { existsSync } from "fs";
import path from "path";

type Severity = "required" | "recommended";

interface Check {
  name: string;
  severity: Severity;
  ok: boolean;
  hint: string;
}

const production = (process.env.NODE_ENV ?? "").toLowerCase() === "production";
const value = (k: string) => (process.env[k] ?? "").trim();

function loadEnvFiles(): void {
  // Minimal .env loader (no dotenv dependency) — .env.local wins over .env.
  for (const file of [".env", ".env.local"]) {
    const p = path.resolve(process.cwd(), file);
    if (!existsSync(p)) continue;
    const raw = require("fs").readFileSync(p, "utf8") as string;
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 0) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      // Later definitions win, matching how dotenv resolves duplicate keys.
      process.env[key] = val;
    }
  }
}

loadEnvFiles();

const checks: Check[] = [];

function add(name: string, severity: Severity, ok: boolean, hint: string) {
  checks.push({ name, severity, ok, hint });
}

// ---------- Always required ----------

const dbUrl = value("DATABASE_URL");
add("DATABASE_URL", "required", dbUrl.length > 0, "PostgreSQL connection string (pooler for serverless).");
if (dbUrl) {
  const looksPostgres = /^postgres(ql)?:\/\//i.test(dbUrl);
  add("DATABASE_URL scheme", "required", looksPostgres, "Must start with postgresql:// (or postgres://).");
  add(
    "DATABASE_URL has no placeholder password",
    "required",
    !/YOUR_PASSWORD|YOUR_PROJECT_REF/i.test(dbUrl),
    "Replace the placeholder values copied from .env.example."
  );
}

const secret = value("SESSION_SECRET");
add("SESSION_SECRET", "required", secret.length > 0, "Generate with: openssl rand -base64 32");
add("SESSION_SECRET length >= 32", "required", secret.length >= 32, "Shorter secrets weaken session/HMAC security.");

const ttl = Number(value("SESSION_TTL_HOURS") || "24");
add("SESSION_TTL_HOURS numeric", "required", Number.isFinite(ttl) && ttl > 0, "Positive number of hours.");

const backend = value("STORAGE_BACKEND") || "local";
add(
  "STORAGE_BACKEND valid",
  "required",
  backend === "local" || backend === "supabase",
  'Must be "local" or "supabase".'
);

// ---------- Production-only requirements ----------

if (production) {
  if (backend === "supabase") {
    add("NEXT_PUBLIC_SUPABASE_URL", "required", value("NEXT_PUBLIC_SUPABASE_URL").length > 0, "Supabase project URL.");
    add(
      "SUPABASE_SERVICE_ROLE_KEY",
      "required",
      value("SUPABASE_SERVICE_ROLE_KEY").length > 0,
      "Server-only key. Never expose it to the browser."
    );
  } else {
    const allowed = value("ALLOW_EPHEMERAL_LOCAL_STORAGE") === "true";
    add(
      "durable storage in production",
      "required",
      allowed,
      "STORAGE_BACKEND=local loses uploads on redeploy. Use supabase, or set ALLOW_EPHEMERAL_LOCAL_STORAGE=true."
    );
  }

  add(
    "NEXT_PUBLIC_APP_URL set to https",
    "required",
    /^https:\/\//.test(value("NEXT_PUBLIC_APP_URL")),
    "Password-reset links are built from this URL."
  );

  const rateStore = value("RATE_LIMIT_STORAGE") || "memory";
  add(
    "shared rate-limit store",
    "recommended",
    rateStore === "redis",
    "Multi-instance deployments should set RATE_LIMIT_STORAGE=redis with Upstash credentials."
  );
  if (rateStore === "redis") {
    add(
      "UPSTASH_REDIS_REST_URL",
      "required",
      value("UPSTASH_REDIS_REST_URL").length > 0,
      "Required when RATE_LIMIT_STORAGE=redis."
    );
    add(
      "UPSTASH_REDIS_REST_TOKEN",
      "required",
      value("UPSTASH_REDIS_REST_TOKEN").length > 0,
      "Required when RATE_LIMIT_STORAGE=redis."
    );
  }

  add(
    "email delivery configured",
    "recommended",
    value("ENABLE_EMAIL_DELIVERY") === "true" &&
      value("EMAIL_API_URL").length > 0 &&
      value("EMAIL_API_KEY").length > 0 &&
      value("EMAIL_FROM").length > 0,
    "Without it, password-reset links cannot be delivered to users."
  );

  add(
    "dev reset tokens not exposed",
    "required",
    value("EXPOSE_RESET_TOKEN_IN_DEV") !== "true",
    "EXPOSE_RESET_TOKEN_IN_DEV must not be enabled in production."
  );
}

// ---------- Report ----------

const failed = checks.filter((c) => !c.ok);
const requiredFailed = failed.filter((c) => c.severity === "required");

console.log(`\nXeroxEase configuration check (NODE_ENV=${process.env.NODE_ENV || "unset"})\n`);
for (const c of checks) {
  const tag = c.ok ? "ok  " : c.severity === "required" ? "FAIL" : "warn";
  console.log(`  [${tag}] ${c.name}${c.ok ? "" : ` — ${c.hint}`}`);
}

if (requiredFailed.length > 0) {
  console.error(`\n${requiredFailed.length} required configuration value(s) missing or invalid.\n`);
  process.exit(1);
}
if (failed.length > 0) {
  console.log(`\n${failed.length} recommended value(s) missing. The app will run with reduced protection.\n`);
}
console.log("\nConfiguration check passed.\n");
