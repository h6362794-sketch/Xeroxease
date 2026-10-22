import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DISPOSABLE_CONFIRMATION_TOKEN,
  EXPECTED_PUBLIC_TABLES,
  REQUIRED_NEW_ORDER_COLUMNS,
  assertLoopbackOnlyTarget,
  assertOutsideRepository,
  redactSecrets,
  resolveRequiredPgTools,
  runIsolatedRehearsalPhase,
  runProdBackupRehearsal,
  validateProductionDirectUrl,
  validateRehearsalTargetUrl,
  verifyBackupDirectoryIntegrity,
} from "../scripts/rehearse-prod-backup";

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function writeExecutable(filePath: string, content: string): void {
  writeFileSync(filePath, content, { mode: 0o755 });
  chmodSync(filePath, 0o755);
}

function buildValidTocText(tables: readonly string[] = EXPECTED_PUBLIC_TABLES): string {
  return [
    "; Archive created at 2026-10-22 10:00:00 UTC",
    ...tables.map((t, idx) => `${200 + idx}; 1259 ${16000 + idx} TABLE public ${t} postgres`),
  ].join("\n");
}

async function startTcpDummyServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((sock) => sock.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function startMockStorageServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const files = [
    { key: "u_1/doc-a.pdf", buf: Buffer.alloc(1024, 0x41) },
    { key: "u_2/doc-b.pdf", buf: Buffer.alloc(2048, 0x42) },
  ];
  const srv = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && reqUrl.pathname === "/storage/v1/object/list/documents") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { prefix = "" } = JSON.parse(body || "{}") as { prefix?: string };
      const out: Array<Record<string, unknown>> = [];
      const dirs = new Set<string>();
      for (const f of files) {
        if (!f.key.startsWith(prefix)) continue;
        const rest = f.key.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash >= 0) {
          const d = rest.slice(0, slash);
          if (!dirs.has(d)) {
            dirs.add(d);
            out.push({ name: d, id: null, metadata: null });
          }
        } else {
          out.push({
            name: rest,
            id: `id-${rest}`,
            metadata: { size: f.buf.length, mimetype: "application/pdf" },
          });
        }
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(out));
      return;
    }
    if (req.method === "GET" && reqUrl.pathname.startsWith("/storage/v1/object/documents/")) {
      const key = reqUrl.pathname
        .slice("/storage/v1/object/documents/".length)
        .split("/")
        .map(decodeURIComponent)
        .join("/");
      const found = files.find((f) => f.key === key);
      if (!found) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.end(found.buf);
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  const port = (srv.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  };
}

describe("Docker-free rehearsal target & URL safety controls", () => {
  it("accepts Session Pooler port 5432 URLs and rejects port 6543, pgbouncer=true, and host overrides", () => {
    const ok = validateProductionDirectUrl(
      "postgresql://postgres.vjwvvoczyuebtowbnuqf:p%40ss%23w0rd!@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=require"
    );
    expect(ok.port).toBe("5432");

    expect(() =>
      validateProductionDirectUrl(
        "postgresql://postgres.ref:secret@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres?sslmode=require"
      )
    ).toThrow(/port 5432/i);

    expect(() =>
      validateProductionDirectUrl(
        "postgresql://postgres.ref:secret@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres?pgbouncer=true&sslmode=require"
      )
    ).toThrow(/pgbouncer=true/i);

    expect(() =>
      validateProductionDirectUrl("postgresql://127.0.0.1:5432/postgres?host=evil.example.com")
    ).toThrow(/SAFETY LOCK/i);
  });

  it("rejects REHEARSAL_DATABASE_URL without explicit REHEARSAL_CONFIRM_DISPOSABLE confirmation", () => {
    expect(() =>
      validateRehearsalTargetUrl({
        rehearsalDatabaseUrl: "postgresql://postgres:pw@127.0.0.1:5432/xe_rehearsal_test",
      })
    ).toThrow(/REHEARSAL_CONFIRM_DISPOSABLE/i);

    const valid = validateRehearsalTargetUrl({
      rehearsalDatabaseUrl: "postgresql://postgres:pw@127.0.0.1:5432/xe_rehearsal_test",
      confirmDisposable: DISPOSABLE_CONFIRMATION_TOKEN,
    });
    expect(valid.hostname).toBe("127.0.0.1");
  });

  it("rejects identical production URLs, production project refs, and production hostnames", () => {
    const prodDirect =
      "postgresql://postgres.vjwvvoczyuebtowbnuqf:secret@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=require";

    // Identical URL
    expect(() =>
      validateRehearsalTargetUrl({
        rehearsalDatabaseUrl: prodDirect,
        confirmDisposable: DISPOSABLE_CONFIRMATION_TOKEN,
        allowRemoteHost: "aws-0-ap-northeast-1.pooler.supabase.com",
        forbiddenUrls: [prodDirect],
      })
    ).toThrow(/SAFETY LOCK/i);

    // Direct host for the same Supabase production project ref
    expect(() =>
      validateRehearsalTargetUrl({
        rehearsalDatabaseUrl:
          "postgresql://postgres:secret@db.vjwvvoczyuebtowbnuqf.supabase.co:5432/postgres?sslmode=require",
        confirmDisposable: DISPOSABLE_CONFIRMATION_TOKEN,
        allowRemoteHost: "db.vjwvvoczyuebtowbnuqf.supabase.co",
        forbiddenUrls: [prodDirect],
      })
    ).toThrow(/vjwvvoczyuebtowbnuqf/i);

    // Dynamically extracted ref from SUPABASE_URL
    expect(() =>
      validateRehearsalTargetUrl({
        rehearsalDatabaseUrl:
          "postgresql://postgres.customprodref99:pw@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require",
        confirmDisposable: DISPOSABLE_CONFIRMATION_TOKEN,
        allowRemoteHost: "aws-0-ap-south-1.pooler.supabase.com",
        forbiddenUrls: ["https://customprodref99.supabase.co"],
      })
    ).toThrow(/customprodref99/i);

    // Database named `prod` / `production`
    expect(() =>
      validateRehearsalTargetUrl({
        rehearsalDatabaseUrl: "postgresql://postgres:pw@127.0.0.1:5432/xeroxease_production",
        confirmDisposable: DISPOSABLE_CONFIRMATION_TOKEN,
      })
    ).toThrow(/SAFETY LOCK/i);
  });

  it("validates temporary isolated cloud PostgreSQL 17 targets safely (host allowlist + TLS + distinct project ref)", () => {
    const prodDirect =
      "postgresql://postgres.vjwvvoczyuebtowbnuqf:secret@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=require";

    // Unapproved cloud host -> rejected
    expect(() =>
      validateRehearsalTargetUrl({
        rehearsalDatabaseUrl:
          "postgresql://neondb_owner:pw@ep-cool-temp-991122.ap-southeast-1.aws.neon.tech:5432/xe_test?sslmode=require",
        confirmDisposable: DISPOSABLE_CONFIRMATION_TOKEN,
        forbiddenUrls: [prodDirect],
      })
    ).toThrow(/REHEARSAL_ALLOW_REMOTE_HOST/i);

    // sslmode=disable on cloud host -> rejected
    expect(() =>
      validateRehearsalTargetUrl({
        rehearsalDatabaseUrl:
          "postgresql://neondb_owner:pw@ep-cool-temp-991122.ap-southeast-1.aws.neon.tech:5432/xe_test?sslmode=disable",
        confirmDisposable: DISPOSABLE_CONFIRMATION_TOKEN,
        allowRemoteHost: "ep-cool-temp-991122.ap-southeast-1.aws.neon.tech",
        forbiddenUrls: [prodDirect],
      })
    ).toThrow(/sslmode/i);

    // Approved isolated Neon PG 17 host with TLS -> accepted
    const neonOk = validateRehearsalTargetUrl({
      rehearsalDatabaseUrl:
        "postgresql://neondb_owner:pw@ep-cool-temp-991122.ap-southeast-1.aws.neon.tech:5432/xe_test?sslmode=require",
      confirmDisposable: DISPOSABLE_CONFIRMATION_TOKEN,
      allowRemoteHost: "ep-cool-temp-991122.ap-southeast-1.aws.neon.tech",
      forbiddenUrls: [prodDirect],
    });
    expect(neonOk.hostname).toBe("ep-cool-temp-991122.ap-southeast-1.aws.neon.tech");

    // Approved separate disposable Supabase project in same region -> accepted ONLY because ref differs
    const tempSbOk = validateRehearsalTargetUrl({
      rehearsalDatabaseUrl:
        "postgresql://postgres.tmpdisposable9988:pw@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=require",
      confirmDisposable: DISPOSABLE_CONFIRMATION_TOKEN,
      allowRemoteHost: "aws-0-ap-northeast-1.pooler.supabase.com",
      forbiddenUrls: [prodDirect],
    });
    expect(tempSbOk.username).toBe("postgres.tmpdisposable9988");
  });

  it("retains strict loopback lock on local admin URLs and out-of-repo backup paths", () => {
    expect(() =>
      assertLoopbackOnlyTarget("postgresql://postgres:pw@127.0.0.1:5432/postgres")
    ).not.toThrow();
    expect(() =>
      assertLoopbackOnlyTarget("postgresql://postgres:pw@remote.example.com:5432/postgres")
    ).toThrow(/SAFETY LOCK/i);
    expect(() =>
      assertOutsideRepository(path.join(process.cwd(), "backups", "inside-repo"), process.cwd())
    ).toThrow(/outside the Git repository/i);
  });

  it("redacts connection strings, passwords, service-role keys, and JWT tokens", () => {
    const dirty =
      "pg_restore failed for postgresql://postgres.ref:TopSecretPw!@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres key=sb_secret_abcdef0123456789 raw=TopSecretPw!";
    const clean = redactSecrets(dirty, ["TopSecretPw!"]);
    expect(clean).not.toContain("TopSecretPw!");
    expect(clean).not.toContain("sb_secret_abcdef0123456789");
    expect(clean).not.toContain("aws-0-ap-northeast-1.pooler.supabase.com");
    expect(clean).toContain("postgresql://[REDACTED]");
  });
});

describe("PostgreSQL client tool detection, backup integrity & failure handling", () => {
  it("fails safely with actionable guidance when client tools are missing or below PostgreSQL 17", () => {
    const emptyBin = makeTempDir("xe-empty-bin-");
    expect(() =>
      resolveRequiredPgTools({
        minMajor: 17,
        pgBinDir: emptyBin,
        includeSystemFallbackDirs: false,
      })
    ).toThrow(/Missing required PostgreSQL client tool/i);

    if (process.platform !== "win32") {
      const oldBin = makeTempDir("xe-pg16-bin-");
      for (const tool of ["psql", "pg_dump", "pg_restore"]) {
        writeExecutable(
          path.join(oldBin, tool),
          `#!/usr/bin/env sh\necho "${tool} (PostgreSQL) 16.4"\n`
        );
      }
      expect(() =>
        resolveRequiredPgTools({
          minMajor: 17,
          pgBinDir: oldBin,
          includeSystemFallbackDirs: false,
        })
      ).toThrow(/older than required PostgreSQL 17/i);
    }
  });

  it("detects corrupted dump SHA-256 and missing required public tables before restore", () => {
    if (process.platform === "win32") return;

    const fakeBin = makeTempDir("xe-toc-bin-");
    const backupDir = makeTempDir("xe-bkp-verify-");
    mkdirSync(path.join(backupDir, "storage"), { recursive: true });

    const dumpBytes = Buffer.from("PGDMP-simulated-archive-payload");
    const dumpSha = createHash("sha256").update(dumpBytes).digest("hex");
    writeFileSync(path.join(backupDir, "xeroxease-prod-public.dump"), dumpBytes);
    writeFileSync(path.join(backupDir, "SHA256SUMS"), `${dumpSha}  xeroxease-prod-public.dump\n`);
    writeFileSync(path.join(backupDir, "storage", "SHA256SUMS"), "");

    // Missing `orders` in TOC -> rejected
    const incompleteTables = EXPECTED_PUBLIC_TABLES.filter((t) => t !== "orders");
    writeExecutable(
      path.join(fakeBin, "pg_restore"),
      `#!/usr/bin/env sh\ncat <<'EOF'\n${buildValidTocText(incompleteTables)}\nEOF\n`
    );
    expect(() =>
      verifyBackupDirectoryIntegrity(backupDir, path.join(fakeBin, "pg_restore"), process.env, [])
    ).toThrow(/public\.orders/i);

    // Complete TOC -> passes
    writeExecutable(
      path.join(fakeBin, "pg_restore"),
      `#!/usr/bin/env sh\ncat <<'EOF'\n${buildValidTocText()}\nEOF\n`
    );
    const verified = verifyBackupDirectoryIntegrity(
      backupDir,
      path.join(fakeBin, "pg_restore"),
      process.env,
      []
    );
    expect(verified.dumpSha256).toBe(dumpSha);
    expect(verified.tocEntries).toBe(EXPECTED_PUBLIC_TABLES.length);

    // Tamper dump file after checksum -> fails closed
    writeFileSync(path.join(backupDir, "xeroxease-prod-public.dump"), Buffer.from("corrupted"));
    expect(() =>
      verifyBackupDirectoryIntegrity(backupDir, path.join(fakeBin, "pg_restore"), process.env, [])
    ).toThrow(/SHA-256 checksum mismatch/i);
  });

  it("executes full Docker-free backup + rehearsal with scrubbed Phase B env, refuses non-empty non-test DBs, and handles failed restores cleanly", async () => {
    if (process.platform === "win32") return;

    const tcpSource = await startTcpDummyServer();
    const mockStorage = await startMockStorageServer();

    try {
      const fakeBin = makeTempDir("xe-mock-pg17-");
      const stateDir = makeTempDir("xe-mock-state-");
      const backupDir = makeTempDir("xe-mock-backup-out-");
      const restoreCalledMarker = path.join(stateDir, "pg_restore_invoked");
      const migrateEnvCapture = path.join(stateDir, "migrate_env.json");

      const all40Cols = [
        "id",
        "order_number",
        "user_id",
        "paper_size",
        "color_mode",
        "duplex",
        "orientation",
        "pages_per_sheet",
        "copies",
        "total_pages",
        "billable_pages",
        "binding_type",
        "lamination",
        "staple",
        "notes",
        "price_per_page",
        "finishing_fee",
        "discount",
        "total_amount",
        "status",
        "payment_status",
        "payment_ref",
        "payment_proof",
        "collection_code",
        "paid_at",
        "printed_at",
        "completed_at",
        "cancelled_at",
        "cancel_reason",
        "created_at",
        "updated_at",
        ...REQUIRED_NEW_ORDER_COLUMNS,
      ];

      // Stateful fake `psql` distinguishing Production URL vs Rehearsal URL
      writeExecutable(
        path.join(fakeBin, "psql"),
        `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
const dsn = args[0] || "";
const cIdx = args.indexOf("-c");
const sql = cIdx >= 0 ? args[cIdx + 1] : "";
if (args.includes("--version")) {
  console.log("psql (PostgreSQL) 17.6");
  process.exit(0);
}
const isSource = dsn.includes("source_db");
const stateFile = path.join(${JSON.stringify(stateDir)}, "state.json");
const state = fs.existsSync(stateFile)
  ? JSON.parse(fs.readFileSync(stateFile, "utf8"))
  : { existingTables: 0, hasMarker: false, migrated: false };

const rowCounts = JSON.stringify({
  users: 2, sessions: 1, password_reset_tokens: 0, recovery_codes: 1,
  pricing_config: 7, orders: 4, uploaded_files: 4, order_events: 6,
  payment_events: 3, feedback: 1, notifications: 2, audit_logs: 5, settings: 2
});
const ordersJson = JSON.stringify([
  { id: "o1", order_number: "XE-1", status: "COMPLETED", payment_status: "PAYMENT_CONFIRMED", has_payment_ref: false, copies: 1, total_pages: 10, billable_pages: 10, price_per_page: "2.00", finishing_fee: "0.00", total_amount: "20.00" },
  { id: "o2", order_number: "XE-2", status: "PAYMENT_PENDING", payment_status: "PAYMENT_PENDING", has_payment_ref: false, copies: 1, total_pages: 5, billable_pages: 5, price_per_page: "2.00", finishing_fee: "0.00", total_amount: "10.00" }
]);
const statusCounts = JSON.stringify({ COMPLETED: 1, PAYMENT_PENDING: 1 });
const pricingJson = JSON.stringify([{ id: "p1", key: "A4_BW", unit_price: "2.00", category: "PRINTING" }]);

if (sql.includes("pg_database WHERE datname")) {
  console.log(isSource ? "source_db:16384" : "xe_rehearsal_test:24576");
} else if (sql.includes("pg_control_system")) {
  console.log(isSource ? "7100000000000000001" : "7200000000000000002");
} else if (sql.includes("server_version_num")) {
  console.log("170006");
} else if (sql.includes("table_schema = '_xe_disposable_rehearsal'")) {
  console.log(state.hasMarker ? "true" : "false");
} else if (sql.includes("CREATE SCHEMA IF NOT EXISTS _xe_disposable_rehearsal")) {
  state.hasMarker = true;
  fs.writeFileSync(stateFile, JSON.stringify(state));
} else if (sql.includes("table_type = 'BASE TABLE'")) {
  console.log(String(state.existingTables));
} else if (sql.includes("json_build_object") && sql.includes("public.users")) {
  console.log(rowCounts);
} else if (sql.includes("FROM public.orders o")) {
  console.log(ordersJson);
} else if (sql.includes("GROUP BY status::text")) {
  console.log(statusCounts);
} else if (sql.includes("sum(total_amount)")) {
  console.log("30.00");
} else if (sql.includes("sum(unit_price)")) {
  console.log("90.00");
} else if (sql.includes("FROM public.pricing_config p")) {
  console.log(pricingJson);
} else if (sql.includes("pg_enum")) {
  console.log(JSON.stringify({
    orderStatus: ["ORDER_RECEIVED","ACCEPTED","PRINTING","READY_FOR_PICKUP","DELIVERED","REJECTED","COMPLETED","PAYMENT_PENDING","PAYMENT_UNDER_REVIEW","READY_FOR_COLLECTION"],
    paymentMethod: ["CASH_ON_DELIVERY","UPI"],
    notificationType: ["ORDER_ACCEPTED","ORDER_REJECTED"]
  }));
} else if (sql.includes("ordinal_position")) {
  console.log(JSON.stringify(${JSON.stringify(all40Cols)}));
} else if (sql.includes("orders_payment_method_payment_status_idx")) {
  console.log("true");
} else if (sql.includes("column_default")) {
  console.log("'ORDER_RECEIVED'::\\"OrderStatus\\"");
} else if (sql.includes("DELIVERED") && sql.includes("UPI")) {
  console.log("5:40:DELIVERED:UPI");
} else if (sql.includes("finished_at IS NULL OR rolled_back_at IS NOT NULL")) {
  console.log("0");
} else if (sql.includes("json_agg(migration_name")) {
  console.log(JSON.stringify([
    "20261013000000_init",
    "20261014000000_recovery_codes",
    "20261015000000_direct_upload_intents",
    "20261020000000_order_lifecycle_enum_values",
    "20261020000100_order_lifecycle_payments_pricing"
  ]));
} else if (sql.includes("count(*) FROM public._prisma_migrations")) {
  console.log(isSource ? "3" : (state.migrated ? "5" : "3"));
}
`
      );

      writeExecutable(
        path.join(fakeBin, "pg_dump"),
        `#!/usr/bin/env sh
if [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) 17.6"; exit 0; fi
printf "PGDMP-MOCK-ARCHIVE-BYTES"
`
      );

      writeExecutable(
        path.join(fakeBin, "pg_restore"),
        `#!/usr/bin/env sh
if [ "$1" = "--version" ]; then echo "pg_restore (PostgreSQL) 17.6"; exit 0; fi
for arg in "$@"; do
  if [ "$arg" = "--list" ]; then
    cat <<'EOF'
${buildValidTocText()}
EOF
    exit 0
  fi
done
touch "${restoreCalledMarker}"
cat >/dev/null
`
      );

      const migrateScript = path.join(stateDir, "run-migrate.js");
      writeFileSync(
        migrateScript,
        `const fs = require("fs");
fs.writeFileSync(${JSON.stringify(migrateEnvCapture)}, JSON.stringify({
  DIRECT_URL: process.env.DIRECT_URL,
  DATABASE_URL: process.env.DATABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? null,
}));
const st = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(stateDir, "state.json"))}, "utf8"));
st.migrated = true;
fs.writeFileSync(${JSON.stringify(path.join(stateDir, "state.json"))}, JSON.stringify(st));
`
      );

      const sourceUrl = `postgresql://postgres:SrcSecret99!@127.0.0.1:${tcpSource.port}/source_db`;
      const targetUrl = `postgresql://postgres:TgtSecret99!@127.0.0.1:${tcpSource.port}/xe_rehearsal_test`;

      const dockerlessPath = [path.dirname(process.execPath), "/bin"].join(path.delimiter);

      // 1. Happy path — full Docker-free execution (`envPath` contains ZERO `docker` binary)
      const result = await runProdBackupRehearsal({
        directUrl: sourceUrl,
        supabaseUrl: mockStorage.url,
        serviceRoleKey: "sb_secret_unit_test_role_key_123456",
        allowInsecureLocalhostStorage: true,
        backupRoot: backupDir,
        rehearsalDatabaseUrl: targetUrl,
        confirmDisposable: DISPOSABLE_CONFIRMATION_TOKEN,
        pgBinDir: fakeBin,
        envPath: dockerlessPath,
        includeSystemFallbackDirs: false,
        rehearsalMigrateCmd: [process.execPath, migrateScript],
        skipOfflinePrismaEnginePreflight: true,
      });

      expect(result.report.dockerUsed).toBe(false);
      expect(result.report.productionModified).toBe(false);
      expect(result.report.rehearsalSchemaVerify).toBe("5:40:DELIVERED:UPI");
      expect(result.report.ordersTotalAmountBefore).toBe("30.00");
      expect(result.report.ordersTotalAmountAfter).toBe("30.00");
      expect(result.report.pricingConfigTotalAfter).toBe("90.00");
      expect(result.report.legacyOrdersDigestAfter).toBe(result.report.legacyOrdersDigestBefore);

      // Verify Phase B child process received ONLY the isolated rehearsal target URL and NO service key
      const capturedEnv = JSON.parse(readFileSync(migrateEnvCapture, "utf8")) as Record<
        string,
        string | null
      >;
      expect(capturedEnv.DIRECT_URL).toBe(targetUrl);
      expect(capturedEnv.DATABASE_URL).toBe(targetUrl);
      expect(capturedEnv.SUPABASE_SERVICE_ROLE_KEY).toBeNull();

      // Verify saved report/manifest never contain secrets
      const rawReportText = readFileSync(result.reportPath, "utf8");
      const rawManifestText = readFileSync(path.join(backupDir, "backup-manifest.json"), "utf8");
      for (const blob of [rawReportText, rawManifestText]) {
        expect(blob).not.toContain("SrcSecret99!");
        expect(blob).not.toContain("TgtSecret99!");
        expect(blob).not.toContain("sb_secret_unit_test_role_key_123456");
      }

      // 2. Non-empty non-test DB safety lock — refuses BEFORE running pg_restore!
      rmSync(restoreCalledMarker, { force: true });
      writeFileSync(
        path.join(stateDir, "state.json"),
        JSON.stringify({ existingTables: 5, hasMarker: false, migrated: false })
      );
      await expect(
        runIsolatedRehearsalPhase({
          backupDir,
          rehearsalDatabaseUrl: targetUrl,
          confirmDisposable: DISPOSABLE_CONFIRMATION_TOKEN,
          pgBinDir: fakeBin,
          envPath: dockerlessPath,
          includeSystemFallbackDirs: false,
          rehearsalMigrateCmd: [process.execPath, migrateScript],
          skipOfflinePrismaEnginePreflight: true,
        })
      ).rejects.toThrow(/SAFETY LOCK.*already contains 5 table/i);
      expect(existsSync(restoreCalledMarker)).toBe(false);

      // 3. Failed pg_restore handling — fails safely and redacts leaked credentials
      writeFileSync(
        path.join(stateDir, "state.json"),
        JSON.stringify({ existingTables: 0, hasMarker: false, migrated: false })
      );
      rmSync(result.reportPath, { force: true });
      writeExecutable(
        path.join(fakeBin, "pg_restore"),
        `#!/usr/bin/env sh
if [ "$1" = "--version" ]; then echo "pg_restore (PostgreSQL) 17.6"; exit 0; fi
for arg in "$@"; do
  if [ "$arg" = "--list" ]; then
    cat <<'EOF'
${buildValidTocText()}
EOF
    exit 0
  fi
done
echo "pg_restore: fatal error on ${targetUrl} token=sb_secret_leak_attempt_999" >&2
exit 1
`
      );
      let caughtErr = "";
      try {
        await runIsolatedRehearsalPhase({
          backupDir,
          rehearsalDatabaseUrl: targetUrl,
          confirmDisposable: DISPOSABLE_CONFIRMATION_TOKEN,
          pgBinDir: fakeBin,
          envPath: dockerlessPath,
          includeSystemFallbackDirs: false,
          rehearsalMigrateCmd: [process.execPath, migrateScript],
          skipOfflinePrismaEnginePreflight: true,
        });
      } catch (err) {
        caughtErr = (err as Error).message;
      }
      expect(caughtErr).toContain("pg_restore: fatal error");
      expect(caughtErr).not.toContain("TgtSecret99!");
      expect(caughtErr).not.toContain("sb_secret_leak_attempt_999");
      expect(existsSync(result.reportPath)).toBe(false);
    } finally {
      await tcpSource.close();
      await mockStorage.close();
    }
  });
});

// Live end-to-end PostgreSQL 17 Docker-free integration check (runs automatically in CI PG17 job
// and whenever PG17_REHEARSAL_SOURCE_URL + PG17_REHEARSAL_TARGET_URL are set locally).
const liveSourceUrl = process.env.PG17_REHEARSAL_SOURCE_URL ?? "";
const liveTargetUrl = process.env.PG17_REHEARSAL_TARGET_URL ?? "";

describe.runIf(Boolean(liveSourceUrl && liveTargetUrl))(
  "Live PostgreSQL 17 Docker-free backup & migration rehearsal",
  () => {
    it("backs up multi-schema Production sim, verifies SHA-256 + Storage, and rehearses migrations on isolated PG17 with Docker disabled", async () => {
      const mockStorage = await startMockStorageServer();
      const backupDir = makeTempDir("xe-live-pg17-rehearsal-");
      const minClientMajor = process.env.PG17_REHEARSAL_MIN_CLIENT_MAJOR
        ? Number(process.env.PG17_REHEARSAL_MIN_CLIENT_MAJOR)
        : 17;
      try {
        const res = await runProdBackupRehearsal({
          directUrl: liveSourceUrl,
          supabaseUrl: mockStorage.url,
          serviceRoleKey: "sb_secret_live_pg17_rehearsal_key",
          allowInsecureLocalhostStorage: true,
          backupRoot: backupDir,
          rehearsalDatabaseUrl: liveTargetUrl,
          confirmDisposable: DISPOSABLE_CONFIRMATION_TOKEN,
          minClientMajor,
        });
        expect(res.report.dockerUsed).toBe(false);
        expect(res.report.productionModified).toBe(false);
        expect(res.report.rehearsalTargetServerVersionNum).toBeGreaterThanOrEqual(170000);
        expect(res.report.rehearsalSchemaVerify).toBe("5:40:DELIVERED:UPI");
        expect(res.report.sourceFinishedMigrationsUnchanged).toBe(3);
        expect(res.report.ordersTotalAmountAfter).toBe(res.report.ordersTotalAmountBefore);
        expect(res.report.pricingConfigTotalAfter).toBe(res.report.pricingConfigTotalBefore);
        expect(res.report.legacyOrdersDigestAfter).toBe(res.report.legacyOrdersDigestBefore);
      } finally {
        await mockStorage.close();
      }
    }, 60_000);
  }
);
