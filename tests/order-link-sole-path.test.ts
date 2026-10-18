import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Invariant: a document joins an order through exactly one path, `createOrder` in src/server/orders.ts,
 * inside the order's transaction, after the document has been priced. No upload endpoint, client
 * field or other write may set `orderId` on an uploaded file. This is a static scan of every
 * `uploadedFile` write call in the application source, so a new alternate path fails the build.
 */

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/** The text of a call's argument list, from the opening parenthesis to its matching close. */
function callArguments(source: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    const c = source[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
  }
  return source.slice(openIndex);
}

/** Every `uploadedFile.<write>(...)` call in the source, with whether its `data` sets `orderId`. */
function uploadedFileWrites(source: string) {
  const found: { setsOrderId: boolean; snippet: string }[] = [];
  const re = /uploadedFile\s*\.\s*(update|updateMany|create|createMany|upsert)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const args = callArguments(source, m.index + m[0].length - 1);
    // Only the `data` object is the write. `where` may legitimately test `orderId: null`.
    const dataAt = args.search(/\bdata\s*:\s*\{/);
    let setsOrderId = false;
    if (dataAt >= 0) {
      const open = args.indexOf("{", dataAt);
      let depth = 0;
      let end = open;
      for (let i = open; i < args.length; i++) {
        if (args[i] === "{") depth++;
        else if (args[i] === "}") {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      // Matches `orderId: x` and the shorthand `orderId,` / `orderId }` used as a key.
      setsOrderId = /\borderId\s*(:|,|\})/.test(args.slice(open, end));
    }
    found.push({ setsOrderId, snippet: args.slice(0, 80).replace(/\s+/g, " ") });
  }
  return found;
}

describe("a document joins an order only through createOrder", () => {
  const files = [...walk(join(ROOT, "src")), join(ROOT, "prisma/seed.ts")];

  it("finds the uploadedFile write calls it is checking (the scan is not vacuous)", () => {
    const orders = readFileSync(join(ROOT, "src/server/orders.ts"), "utf8");
    expect(uploadedFileWrites(orders).length).toBeGreaterThan(0);
  });

  it("sets orderId on an uploaded file in exactly one place: createOrder's transaction in src/server/orders.ts", () => {
    const setters: string[] = [];
    let linkCount = 0;
    for (const file of files) {
      const rel = relative(ROOT, file).split("\\").join("/");
      for (const w of uploadedFileWrites(readFileSync(file, "utf8"))) {
        if (w.setsOrderId) {
          setters.push(rel);
          if (rel === "src/server/orders.ts") linkCount++;
        }
      }
    }
    expect(setters).toEqual(["src/server/orders.ts"]);
    expect(linkCount).toBe(1);
  });

  it("the single link in orders.ts is inside the order transaction and is conditional on an unlinked, verified, unpurged document", () => {
    const source = readFileSync(join(ROOT, "src/server/orders.ts"), "utf8");
    const linkAt = source.indexOf("data: { orderId: o.id }");
    expect(linkAt).toBeGreaterThan(0);
    const before = source.slice(Math.max(0, linkAt - 700), linkAt);
    expect(before).toMatch(/tx\.uploadedFile\.updateMany/);
    expect(before).toMatch(/orderId:\s*null/);
    expect(before).toMatch(/status:\s*"COMPLETED"/);
    expect(before).toMatch(/purgedAt:\s*null/);
    expect(before).toMatch(/pageCount:\s*f\.pageCount/);
  });

  it("no upload route reads orderId from the client; its only use is the unattached-document predicate `orderId: null`", () => {
    const uploadRoutes = walk(join(ROOT, "src/app/api/uploads"));
    for (const file of uploadRoutes) {
      const source = readFileSync(file, "utf8");
      // Comments may mention the removed field, and `orderId: null` is a query predicate that
      // selects unattached documents. Any other use would be the client supplying a link.
      const code = source.replace(/\/\/.*$/gm, "").replace(/\borderId\s*:\s*null\b/g, "");
      expect(code, relative(ROOT, file)).not.toMatch(/\borderId\b/);
    }
  });
});
