// Regression coverage for the schema/migration index drift that the first real CI
// run caught and that `npm run schema:check` previously missed entirely.
//
// Background: the RecoveryCode model declared BOTH `userId @unique` and
// `@@index([userId])`. A `@unique` field already produces a unique B-tree index on
// that column, so the extra `@@index` asked for a second, redundant index. The
// migration created only the unique one, so schema.prisma and the migrations
// disagreed. `prisma migrate diff --exit-code` (authoritative, database-backed)
// reported:
//
//     Changed the recovery_codes table: Added index on columns (user_id)
//
// ...while the text-level `npm run schema:check` passed, because it never looked at
// indexes at all. These tests lock in both halves of the fix: the model must not
// declare a redundant index, and the checker must notice if one is ever reintroduced.

import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, rmSync, mkdirSync, cpSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const SCHEMA = join(ROOT, "prisma", "schema.prisma");

/**
 * Read schema.prisma with `//` comment lines removed.
 *
 * The explanatory comment on the RecoveryCode model deliberately contains the
 * literal text `@@index([userId])`; without stripping comments, a naive regex would
 * "find" an index that is only being discussed.
 */
function schemaWithoutComments(): string {
  return readFileSync(SCHEMA, "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

/** Extract the body of a named model block from schema.prisma. */
function modelBody(name: string): string {
  const m = schemaWithoutComments().match(
    new RegExp(`model\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`)
  );
  if (!m) throw new Error(`model ${name} not found in prisma/schema.prisma`);
  return m[1];
}

describe("RecoveryCode index declaration", () => {
  it("does not declare a redundant @@index on a column that is already @unique", () => {
    const body = modelBody("RecoveryCode");

    // userId must stay unique: one live recovery code per account is what makes
    // rotation safe (no window in which two codes are valid at once).
    expect(/userId\s+String\s+@unique/.test(body)).toBe(true);

    // ...and it must NOT also carry a plain @@index([userId]).
    expect(body).not.toMatch(/@@index\(\[userId\]\)/);
  });

  it("adds no NEW redundant index beyond the one already acknowledged", () => {
    const src = schemaWithoutComments();
    const modelRe = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
    let m: RegExpExecArray | null;
    const offenders: string[] = [];

    while ((m = modelRe.exec(src)) !== null) {
      const [, name, body] = m;
      // Fields declared @unique at the field level.
      const uniqueFields = new Set<string>();
      for (const raw of body.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("@@")) continue;
        const fm = line.match(/^(\w+)\s+\w+/);
        if (fm && /\s@unique(\s|$)/.test(line)) uniqueFields.add(fm[1]);
      }
      // Any @@index([...]) whose entire column list is a single @unique field is
      // redundant: the unique index already serves every lookup on that column.
      const idxRe = /@@index\(\[([^\]]*)\]\)/g;
      let ix: RegExpExecArray | null;
      while ((ix = idxRe.exec(body)) !== null) {
        const cols = ix[1].split(",").map((c) => c.trim()).filter(Boolean);
        if (cols.length === 1 && uniqueFields.has(cols[0])) {
          offenders.push(`${name}: @@index([${cols[0]}]) duplicates @unique on the same field`);
        }
      }
    }

    // KNOWN, PRE-EXISTING redundancy — deliberately allowed, not hidden.
    //
    // Order.orderNumber is @unique AND carries @@index([orderNumber]). Unlike the
    // RecoveryCode case, BOTH indexes are actually created by the init migration
    // ("orders_order_number_key" and "orders_order_number_idx"), so this is
    // redundancy, not schema/migration drift: it does not fail
    // `prisma migrate diff`. It is still wasteful — a second B-tree over a column
    // the unique index already covers — but removing it means a DROP INDEX
    // migration, which is a schema change deliberately kept out of this
    // corrective pass.
    //
    // This allowlist is intentionally exact-length: adding any further redundant
    // index will fail this test.
    const KNOWN = ["Order: @@index([orderNumber]) duplicates @unique on the same field"];
    expect(offenders).toEqual(KNOWN);
  });
});

describe("schema:check detects index drift", () => {
  it("passes on the committed schema", () => {
    const out = runTsx(join(ROOT, "scripts", "verify-migrations.ts"), ROOT);
    expect(out).toContain("every declared index exists");
  });

  it("FAILS if RecoveryCode re-declares @@index([userId]) without a matching migration", () => {
    // Run the checker against a mutated copy in a temp dir, so the committed schema
    // is never touched. The checker resolves prisma/ relative to process.cwd().
    const tmp = join(ROOT, ".data", "idx-drift-probe");
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(join(tmp, "prisma"), { recursive: true });
    cpSync(join(ROOT, "prisma", "migrations"), join(tmp, "prisma", "migrations"), { recursive: true });

    const mutated = join(tmp, "prisma", "schema.prisma");
    const src = readFileSync(SCHEMA, "utf8");
    // Reintroduce exactly the drift CI reported.
    const withDrift = src.replace(
      /(model RecoveryCode \{[\s\S]*?)(\n\})/,
      "$1\n  @@index([userId])$2"
    );
    if (withDrift === src) throw new Error("failed to inject the drift");
    // Write with fs rather than a shell heredoc: the schema contains backticks and
    // quotes that a heredoc would mangle.
    writeFileSync(mutated, withDrift, "utf8");

    // Use the repo's own tsx entry directly (see runTsx): the old code spawned
    // `npx` and `.bin/tsx`, which need a shell on Windows and fail with ENOENT.
    const script = join(ROOT, "scripts", "verify-migrations.ts");

    let exitCode = 0;
    let output = "";
    try {
      output = runTsx(script, tmp);
    } catch (err) {
      exitCode = (err as { status?: number }).status ?? 1;
      const e = err as { stdout?: string; stderr?: string };
      output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }

    rmSync(tmp, { recursive: true, force: true });

    expect(exitCode).toBe(1);
    expect(output).toContain("RecoveryCode declares an index");
    expect(output).toContain("user_id");
  });
});

/**
 * Run the repo's own tsx against a script without touching the shell.
 *
 * Spawning `npx` or `.bin/tsx` by bare name needs a shell on Windows
 * (`npx.cmd` / `tsx.cmd` shims), and `rm` / `mkdir -p` / `cp -r` do not exist
 * there at all — both halves of this suite failed on Windows with
 * `spawnSync ... ENOENT`. Invoking the Node binary directly on tsx's CLI entry
 * works on every platform with no shell involved.
 */
function runTsx(script: string, cwd: string): string {
  const tsxCli = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  return execFileSync(process.execPath, [tsxCli, script], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
