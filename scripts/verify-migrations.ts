/**
 * Verify that the committed SQL migrations actually produce the schema declared in
 * prisma/schema.prisma.
 *
 * Why this exists: `prisma migrate deploy` cannot be run in this sandbox (the Prisma
 * engine binaries are not downloadable), so there is no database to introspect. This
 * script is the substitute: it parses both files independently and reports any drift
 * between them.
 *
 * It is NOT a replacement for running the migration against a real PostgreSQL. It
 * checks that the SQL we wrote matches the schema we declared. Applying the migration
 * to a real database is still required before any migration may be marked applied —
 * CI does exactly that against a Postgres service container.
 *
 * Usage: npx tsx scripts/verify-migrations.ts   (also wired to `npm run schema:check`)
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SCHEMA = join(ROOT, "prisma", "schema.prisma");
const MIGRATIONS = join(ROOT, "prisma", "migrations");

const SCALARS = [
  "String", "Int", "BigInt", "Float", "Decimal", "Boolean",
  "DateTime", "Json", "Bytes", "Unsupported",
];

interface SchemaField {
  name: string;
  column: string;
  isRelation: boolean;
}

interface SchemaModel {
  name: string;
  table: string;
  fields: SchemaField[];
}

// ---------------------------------------------------------------------------
// Parse prisma/schema.prisma
// ---------------------------------------------------------------------------

function parseSchema(src: string): SchemaModel[] {
  const models: SchemaModel[] = [];

  // Enum types are scalars to Prisma, not relations: `role Role` produces a column
  // named `role`, exactly like `name String`. Treating them as relations would
  // report every enum-backed column as an orphan.
  const enumNames = new Set<string>();
  const enumRe = /enum\s+(\w+)\s*\{/g;
  let en: RegExpExecArray | null;
  while ((en = enumRe.exec(src)) !== null) enumNames.add(en[1]);
  const text = src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

  const modelRe = /model\s+(\w+)\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = modelRe.exec(text)) !== null) {
    const [, name, body] = m;
    const fields: SchemaField[] = [];

    for (const raw of body.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("@@")) continue;

      const parts = line.split(/\s+/);
      if (parts.length < 2) continue;

      const fieldName = parts[0];
      const type = parts[1].replace(/[[\]?]/g, "");
      const isRelation =
        /^[A-Z]/.test(type) && !SCALARS.includes(type) && !enumNames.has(type);

      const columnMatch = line.match(/@map\("([^"]+)"\)/);
      fields.push({
        name: fieldName,
        column: columnMatch ? columnMatch[1] : fieldName,
        isRelation,
      });
    }

    const tableMatch = body.match(/@@map\("([^"]+)"\)/);
    models.push({ name, table: tableMatch ? tableMatch[1] : name, fields });
  }
  return models;
}

// ---------------------------------------------------------------------------
// Parse migration SQL
// ---------------------------------------------------------------------------

function parseMigrations(dir: string) {
  const tables = new Map<string, Set<string>>();
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  for (const folder of files) {
    const sql = readFileSync(join(dir, folder, "migration.sql"), "utf8");

    const createRe = /CREATE\s+TABLE\s+"?(\w+)"?\s*\(([\s\S]*?)\n\);/g;
    let c: RegExpExecArray | null;
    while ((c = createRe.exec(sql)) !== null) {
      const [, table, body] = c;
      if (!tables.has(table)) tables.set(table, new Set());
      for (const rawLine of body.split("\n")) {
        const line = rawLine.trim();
        if (!line || line.startsWith("--") || line.toUpperCase().startsWith("CONSTRAINT")) continue;
        const col = line.match(/^"?(\w+)"?\s+/);
        if (col) tables.get(table)!.add(col[1]);
      }
    }

    const addRe = /ALTER\s+TABLE\s+"?(\w+)"?\s+ADD\s+(?:CONSTRAINT\s+\S+\s+)?COLUMN\s+"?(\w+)"?/gi;
    let a: RegExpExecArray | null;
    while ((a = addRe.exec(sql)) !== null) {
      if (!tables.has(a[1])) tables.set(a[1], new Set());
      tables.get(a[1])!.add(a[2]);
    }

    const dropRe = /ALTER\s+TABLE\s+"?(\w+)"?\s+DROP\s+COLUMN\s+"?(\w+)"?/gi;
    let d: RegExpExecArray | null;
    while ((d = dropRe.exec(sql)) !== null) {
      tables.get(d[1])?.delete(d[2]);
    }
  }
  return { tables, files };
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

const schemaSrc = readFileSync(SCHEMA, "utf8");
const models = parseSchema(schemaSrc);
const { tables, files } = parseMigrations(MIGRATIONS);

const problems: string[] = [];

console.log(`Migrations found: ${files.join(", ") || "(none)"}\n`);

for (const model of models) {
  if (!tables.has(model.table)) {
    problems.push(`model ${model.name} -> table "${model.table}" is NOT created by any migration`);
    continue;
  }
  const cols = tables.get(model.table)!;

  for (const field of model.fields) {
    if (field.isRelation) continue; // relations are foreign keys, not columns
    if (!cols.has(field.column)) {
      problems.push(
        `${model.name}.${field.name} -> column "${model.table}"."${field.column}" is missing from the migrations`
      );
    }
  }

  for (const col of cols) {
    const declared = model.fields.some((f) => !f.isRelation && f.column === col);
    if (!declared) {
      problems.push(`table "${model.table}" has column "${col}" that schema.prisma does not declare`);
    }
  }
}

console.log(`Models checked: ${models.length}`);
for (const m of models) {
  const cols = tables.get(m.table);
  console.log(`  ${m.table.padEnd(28)} ${cols ? `${cols.size} columns` : "MISSING"}`);
}
console.log("");

if (problems.length > 0) {
  console.error(`✗ ${problems.length} schema/migration mismatch(es):\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    "\nDo NOT mark any migration as applied until this is resolved, and never run\n" +
      "`prisma migrate resolve --applied` for a migration whose SQL you have not read."
  );
  process.exit(1);
}

console.log(
  "✓ Every model in schema.prisma is created by the migrations, every non-relation\n" +
    "  field maps to a column, and no orphan columns were found.\n"
);
console.log(
  "This is a TEXT comparison of schema.prisma against the migration SQL. It does not\n" +
    "execute the SQL and it does not verify types, defaults, nullability, indexes or\n" +
    "foreign keys. Applying the migration to a real PostgreSQL database is still\n" +
    "required before it may be marked as applied (CI does that against a Postgres\n" +
    "service container)."
);
