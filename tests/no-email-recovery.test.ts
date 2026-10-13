// Regression guard: password recovery must stay email-free.
//
// These assertions exist so that reintroducing an email/SMS reset path — or a paid
// third-party recovery dependency — fails the build rather than slipping in. They are
// deliberately blunt: they scan the source tree and the dependency manifest rather
// than executing code, because the property being protected is "this integration does
// not exist", which cannot be tested by calling anything.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (["node_modules", ".next", ".git", ".data", "coverage"].includes(entry)) continue;
      walk(full, out);
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs|json|sql|prisma)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Source files that make up the shipped application (not tests, not this guard). */
function appFiles(): { path: string; text: string }[] {
  return walk(join(ROOT, "src"))
    .concat(walk(join(ROOT, "scripts")).filter((f) => f.endsWith(".ts")))
    .concat([join(ROOT, "prisma", "schema.prisma")])
    .filter((f) => existsSync(f))
    .map((f) => ({ path: relative(ROOT, f), text: readFileSync(f, "utf8") }));
}

describe("password recovery is email-free", () => {
  const files = appFiles();

  it("does not ship the removed email reset modules", () => {
    for (const removed of [
      "src/server/email.ts",
      "src/server/password-reset.ts",
      "src/app/(auth)/reset-password/page.tsx",
      "src/app/api/auth/forgot-password/route.ts",
      "src/app/api/auth/reset-password/route.ts",
    ]) {
      expect(existsSync(join(ROOT, removed)), `${removed} should no longer exist`).toBe(false);
    }
  });

  it("reads no email, SMTP or SMS configuration", () => {
    const offenders: string[] = [];
    for (const { path, text } of files) {
      for (const pattern of [
        /\bENABLE_EMAIL_DELIVERY\b/,
        /\bEMAIL_API_URL\b/,
        /\bEMAIL_API_KEY\b/,
        /\bEMAIL_FROM\b/,
        /\bEXPOSE_RESET_TOKEN_IN_DEV\b/,
        /\bSMTP_[A-Z_]+\b/,
        /\bSENDGRID|SEND_GRID\b/,
        /\bMAILGUN\b/,
      ]) {
        if (pattern.test(text)) offenders.push(`${path} :: ${pattern}`);
      }
    }
    // `.env.example` documents that the config is deliberately absent; that is a
    // comment, not a code path, and lives outside src/ + scripts/.
    expect(offenders).toEqual([]);
  });

  it("ships no email or SMS SDK in its dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const banned = [
      "nodemailer", "resend", "@sendgrid/mail", "mailgun.js", "postmark",
      "ses", "@aws-sdk/client-ses", "twilio", "emailjs-com", "form-data",
    ];
    const present = banned.filter((b) => b in deps);
    expect(present).toEqual([]);
  });

  it("never calls out to an email or SMS transport", async () => {
    // A dynamic import of a mail library, or a hand-rolled fetch to a mail API,
    // would reintroduce the dependency without touching package.json.
    const offenders: string[] = [];
    for (const { path, text } of files) {
      if (/from\s+["'](nodemailer|resend|@sendgrid\/mail|twilio)["']/.test(text)) {
        offenders.push(`${path} imports a mail/SMS SDK`);
      }
      if (/api\.resend\.com|api\.sendgrid\.com|api\.mailgun\.net|api\.twilio\.com/.test(text)) {
        offenders.push(`${path} calls a mail/SMS API host`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("routes recovery through the recovery-code endpoints", () => {
    expect(existsSync(join(ROOT, "src/app/api/auth/recovery/reset/route.ts"))).toBe(true);
    expect(existsSync(join(ROOT, "src/app/api/auth/recovery/code/route.ts"))).toBe(true);
    expect(existsSync(join(ROOT, "src/app/api/auth/recovery/status/route.ts"))).toBe(true);
    expect(existsSync(join(ROOT, "src/app/api/admin/users/[id]/recovery-code/route.ts"))).toBe(true);
  });
});
