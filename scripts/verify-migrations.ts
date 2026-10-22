/**
 * Pre-flight drift check: compares prisma/schema.prisma against the committed
 * migration SQL by parsing both files as text.
 *
 * WHAT IT CHECKS: tables, columns, indexes and unique constraints.
 *
 * WHAT IT DOES NOT DO: it never executes the SQL and never connects to a database, so
 * it cannot verify types, precision, defaults, nullability, constraint names, foreign
 * keys or enums. A pass here is a necessary condition, not a sufficient one — it has
 * previously passed while real drift existed.
 *
 * The authoritative, database-backed check is a separate required CI job:
 *
 *   npx prisma migrate diff --from-migrations prisma/migrations \
 *     --to-schema-datamodel prisma/schema.prisma \
 *     --shadow-database-url "$SHADOW_DATABASE_URL" --exit-code
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
  isUnique: boolean;
}

/** An index/unique constraint declared in schema.prisma. */
interface SchemaIndex {
  /** Column names (already mapped through @map), sorted for stable comparison. */
  columns: string[];
  unique: boolean;
}

interface SchemaModel {
  name: string;
  table: string;
  fields: SchemaField[];
  indexes: SchemaIndex[];
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
          isUnique: /\s@unique(\s|$)/.test(line),
        });
      }

      // --- indexes / unique constraints ------------------------------------
      // Both `@unique` on a field and `@@index([...])` produce an index. A model
      // that declares `@@index([userId])` on a field that is ALSO `@unique` asks
      // for two indexes over the same column, and the migration must create both.
      // Skipping this comparison is how a missing `CREATE INDEX` once reached CI
      // undetected, so it is checked here explicitly.
      const indexes: SchemaIndex[] = [];
      const columnOf = (fieldName: string): string =>
        fields.find((f) => f.name === fieldName)?.column ?? fieldName;

      for (const f of fields) {
        if (f.isRelation) continue;
        if (f.isUnique) indexes.push({ columns: [f.column], unique: true });
      }

      const blockRe = /@@(unique|index)\(\[([^\]]*)\]\)/g;
      let b: RegExpExecArray | null;
      while ((b = blockRe.exec(body)) !== null) {
        const isUnique = b[1] === "unique";
        const cols = b[2]
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean)
          .map(columnOf);
        if (cols.length > 0) indexes.push({ columns: cols, unique: isUnique });
      }

      const tableMatch = body.match(/@@map\("([^"]+)"\)/);
      models.push({ name, table: tableMatch ? tableMatch[1] : name, fields, indexes });
    }
    return models;
  }

// ---------------------------------------------------------------------------
// Parse migration SQL
// ---------------------------------------------------------------------------

  function parseMigrations(dir: string) {
    const tables = new Map<string, Set<string>>();
    const indexes = new Set<string>();
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

      // CREATE [UNIQUE] INDEX "name" ON "table"("col_a", "col_b")
      const idxRe =
        /CREATE\s+(UNIQUE\s+)?INDEX\s+"?[\w]+"?\s+ON\s+"?(\w+)"?\s*\(([^)]*)\)/gi;
      let ix: RegExpExecArray | null;
      while ((ix = idxRe.exec(sql)) !== null) {
        const unique = Boolean(ix[1]);
        const table = ix[2];
        const cols = ix[3]
          .split(",")
          .map((c) => c.trim().replace(/^"|"$/g, ""))
          .filter(Boolean);
        if (cols.length > 0) indexes.add(indexKey(table, cols, unique));
      }

      // DROP INDEX "name" cannot be matched back to its columns, so a dropped
      // index is deliberately not removed here. Forward-only migrations rarely
      // drop indexes, and a false negative here is far safer than a false pass.
    }
    return { tables, indexes, files };
  }

  /** Stable key for an index: table + sorted columns + uniqueness. */
  function indexKey(table: string, columns: string[], unique: boolean): string {
    return `${table}|${[...columns].sort().join(",")}|${unique ? "unique" : "index"}`;
  }

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

  const schemaSrc = readFileSync(SCHEMA, "utf8");
  const models = parseSchema(schemaSrc);
  const { tables, indexes, files } = parseMigrations(MIGRATIONS);

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

    // --- indexes / unique constraints --------------------------------------
    // Every index the model declares must exist in the migrations, and vice
    // versa. This is the check that would have caught the RecoveryCode model
    // declaring both `userId @unique` and `@@index([userId])` while the
    // migration created only the unique index — a mismatch the authoritative
    // `prisma migrate diff` reported as
    //   "Changed the recovery_codes table: Added index on columns (user_id)".
    for (const idx of model.indexes) {
      const key = indexKey(model.table, idx.columns, idx.unique);
      if (!indexes.has(key)) {
        problems.push(
          `${model.name} declares ${idx.unique ? "a unique constraint" : "an index"} on ` +
            `("${idx.columns.join('", "')}") but no migration creates it`
        );
      }
    }

    const prefix = `${model.table}|`;
    for (const key of indexes) {
      if (!key.startsWith(prefix)) continue;
      const [, colsPart, kind] = key.split("|");
      const declared = model.indexes.some(
        (idx) =>
          [...idx.columns].sort().join(",") === colsPart &&
          (idx.unique ? "unique" : "index") === kind
      );
      if (!declared) {
        problems.push(
          `migrations create ${kind === "unique" ? "a unique index" : "an index"} on ` +
            `"${model.table}"("${colsPart.split(",").join('", "')}") that schema.prisma does not declare`
        );
      }
    }
  }

  console.log(`Models checked: ${models.length}`);
  for (const m of models) {
    const cols = tables.get(m.table);
    const nIdx = m.indexes.length;
    console.log(
      `  ${m.table.padEnd(28)} ${cols ? `${cols.size} columns` : "MISSING"}, ${nIdx} index(es)`
    );
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
      "  field maps to a column, every declared index exists, and no orphan columns or\n" +
      "  indexes were found.\n"
  );
  console.log(
    "SCOPE — READ BEFORE TREATING THIS AS VALIDATION.\n" +
      "This is a TEXT comparison of schema.prisma against the migration SQL. It parses\n" +
      "both files independently and checks four things: tables, columns, indexes and\n" +
      "unique constraints. It is a fast pre-flight check, NOT proof that the schema is\n" +
      "correct.\n\n" +
      "It does NOT execute the SQL, and it does NOT verify column types, precision,\n" +
      "defaults, nullability, constraint names, foreign keys, enums, or index methods.\n" +
      "It also deliberately does not treat `@default(uuid())` or `@default(now())` as\n" +
      "requiring a database-level DEFAULT: in Prisma ORM v6 those are generated by the\n" +
      "ORM, so flagging a missing SQL DEFAULT would be a false positive.\n\n" +
      "A green result here must never be described as \"migrations validated\". The\n" +
      "authoritative check is database-backed and lives in the CI `migrations` job:\n\n" +
      "  npx prisma migrate diff \\\n" +
      "    --from-migrations prisma/migrations \\\n" +
      "    --to-schema-datamodel prisma/schema.prisma \\\n" +
      "    --shadow-database-url \"$SHADOW_DATABASE_URL\" \\\n" +
      "    --exit-code\n\n" +
      "CI replays the migrations on real PostgreSQL 16 and 17 services.\n" +
      "Never mark a migration as applied on the strength of this script alone, and never\n" +
      "run `prisma migrate resolve --applied` for a migration whose SQL you have not read."
  );
