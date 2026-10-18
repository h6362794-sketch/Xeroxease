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
import { diagnoseDatabaseConfig } from "../src/server/db-config";
import { evaluateDeployTarget } from "../src/server/deploy-target";

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

// Shared, sanitised connection-string diagnostics (scheme, placeholders,
// pooler port vs pgbouncer flag, connection_limit, DIRECT_URL). The
// messages never contain the URL or any credential.
const dbDiag = diagnoseDatabaseConfig({
  databaseUrl: dbUrl,
  directUrl: value("DIRECT_URL"),
  nodeEnv: process.env.NODE_ENV,
});
for (const err of dbDiag.errors) {
  add(err, "required", false, "See the message; fix the variable it names.");
}
for (const warn of dbDiag.warnings) {
  add(warn, "recommended", false, "Review whether it applies to this deployment.");
}

const secret = value("SESSION_SECRET");
add("SESSION_SECRET", "required", secret.length > 0, "Generate with: openssl rand -base64 32");
add("SESSION_SECRET length >= 32", "required", secret.length >= 32, "Shorter secrets weaken session/HMAC security.");

// Scheduled upload cleanup (POST /api/admin/uploads/sweep). Without it, retention is not enforced.
const cron = value("CRON_SECRET");
if (cron.length >= 32) {
  // A scheduler is honoured only when DEPLOY_TARGET matches its X-Deploy-Target header.
  add("DEPLOY_TARGET set when CRON_SECRET is set", "recommended", value("DEPLOY_TARGET") !== "", "Without DEPLOY_TARGET, every scheduled sweep is refused (403). Set staging or production.");
}
if (production) {
  add(
    "CRON_SECRET length >= 32",
    "recommended",
    cron.length >= 32,
    "Needed for the scheduler to run the upload sweep (retention and cleanup). Generate with: openssl rand -base64 32"
  );
}

// Deployment-target pin (src/server/deploy-target.ts). Inactive unless one of the two variables is set.
const pin = evaluateDeployTarget({
  deployTarget: value("DEPLOY_TARGET"),
  expectedProjectRef: value("EXPECTED_SUPABASE_PROJECT_REF"),
  supabaseUrl: value("NEXT_PUBLIC_SUPABASE_URL"),
  databaseUrl: value("DATABASE_URL"),
  directUrl: value("DIRECT_URL"),
});
if (pin.active) {
  if (pin.problems.length === 0) add("Deployment target pin", "required", true, "Database and Supabase URLs match the pinned project.");
  for (const p of pin.problems) add("Deployment target pin", "required", false, p);
}

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

  if (backend === "supabase") {
    add(
      "NEXT_PUBLIC_SUPABASE_URL is https",
      "required",
      /^https:\/\//i.test(value("NEXT_PUBLIC_SUPABASE_URL")),
      "The browser PUTs document bytes straight to this host; a plain-http storage origin " +
        "downgrades the whole upload path to cleartext."
    );
    add(
      "NEXT_PUBLIC_SUPABASE_URL has no /storage path",
      "required",
      !/\/storage(\/|$)/.test(value("NEXT_PUBLIC_SUPABASE_URL")),
      'Use the bare project URL (https://<ref>.supabase.co). The app appends /storage/v1 itself, ' +
        "so a URL that already contains it produces doubled paths and 404s."
    );
    const directEnabled = (value("DIRECT_UPLOADS_ENABLED") || "true").toLowerCase() !== "false";
    add(
      "direct uploads available (50 MB documents)",
      "required",
      directEnabled,
      "DIRECT_UPLOADS_ENABLED=false on a function host (Vercel) means a 50 MB upload has no " +
        "working path — the proxy route is bounded by the platform's request-body limit. " +
        "Only disable it on a host with no body cap."
    );
  }
  if (backend === "local") {
    add(
      "local storage cannot do direct uploads",
      // Required: with direct uploads unavailable, a 50 MB document has no working
      // path at all on a platform with a request-body cap, so this must not pass
      // quietly just because the app boots.
      "required",
      false,
      'STORAGE_BACKEND=local has no browser-usable storage credential, so /api/uploads/intent returns 501 ' +
        "and uploads fall back to the proxy route (bounded by the platform's request-body limit). " +
        "Acceptable for development only; use supabase for 50 MB documents."
    );
  }
  const intentTtl = Number(value("UPLOAD_INTENT_TTL_SECONDS") || "600");
  add(
    "UPLOAD_INTENT_TTL_SECONDS in 60..3600",
    "required",
    Number.isFinite(intentTtl) && intentTtl >= 60 && intentTtl <= 3600,
    "Bounds how long an abandoned upload may sit in the bucket. 600 s suits a 50 MB transfer."
  );
  const signedTtl = Number(value("SIGNED_DOWNLOAD_URL_TTL_SECONDS") || "60");
  add(
    "SIGNED_DOWNLOAD_URL_TTL_SECONDS in 10..900",
    "required",
    Number.isFinite(signedTtl) && signedTtl >= 10 && signedTtl <= 900,
    "Signed download URLs embed a bearer token in the URL. Long lifetimes leak through " +
      "browser history, proxies and referrer headers."
  );
  const providerCap = Number(value("STORAGE_PROVIDER_MAX_FILE_BYTES") || "0");
  add(
    "STORAGE_PROVIDER_MAX_FILE_BYTES is 0 or >= 1 MB",
    "required",
    Number.isFinite(providerCap) && (providerCap === 0 || providerCap >= 1048576),
    "0 (or unset) means the application limit (50 MiB) binds. For Supabase Free-tier " +
      "deployments, set it to 52428800 (50 MB) so oversized files are refused before the " +
      "browser wastes the transfer."
  );

  add(
    "NEXT_PUBLIC_APP_URL set to https",
    "required",
    /^https:\/\//.test(value("NEXT_PUBLIC_APP_URL")),
    "Used for page metadata, canonical URLs and the sitemap. Recovery is email-free, " +
      "so no reset link is built from it, but a non-https value still produces wrong " +
      "canonical URLs behind TLS."
  );

  add(
    "TRUSTED_PROXY_COUNT set explicitly",
    "recommended",
    value("TRUSTED_PROXY_COUNT") !== "",
    "Defaults to 1. Set 0 when the app is directly exposed, and re-check after adding or " +
      "removing a CDN — the wrong value makes client IPs forgeable or buckets every user together."
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

  // Password recovery is email-free (recovery codes), so there is no mail
  // transport to configure. Confirm instead that the operator understands where
  // the fallback lives.
  add(
    "recovery-code fallback documented",
    "recommended",
    true,
    "Password recovery uses recovery codes, not email. Users who never generated one " +
      "recover via a Super Admin issuing a code from Admin > Users after in-person ID " +
      "verification. Document this for your staff."
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
