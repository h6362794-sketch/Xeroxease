// Seed credential policy — pure logic, separated from prisma/seed.ts so
// it can be unit-tested without a database.
//
// Policy:
//   * Development (NODE_ENV !== "production"): documented default
//     passwords may be used so `npm run db:seed` works out of the box.
//   * Production: every privileged (admin) account MUST get an
//     operator-supplied, sufficiently strong password. The seed fails
//     closed with an actionable message — it never invents, prints or
//     falls back to a publicly documented default for an admin.
//   * Operator-supplied passwords are always strength-checked, for
//     every account type.
//   * The seed never reassigns a password to an existing account
//     (upsert `update: {}`), so routine reseeding cannot rotate or
//     weaken credentials, and never deletes or disables accounts.

/** Minimum length for operator-supplied seed passwords. */
export const MIN_SEED_PASSWORD_LENGTH = 12;

/** Passwords published in this repository for local development only. */
export const DEV_DEFAULT_STUDENT_PASSWORD = "Student@123";
export const DEV_DEFAULT_ADMIN_PASSWORD = "Admin@123";

export interface SeedPasswordInput {
  nodeEnv: string;
  seedStudentPassword?: string;
  seedAdminPassword?: string;
  allowDevSeed?: boolean;
}

export interface SeedPasswords {
  studentPassword: string;
  adminPassword: string;
  /** Where each password came from, for logs that never print values. */
  studentSource: "env" | "dev-default";
  adminSource: "env" | "dev-default";
}

function isProduction(nodeEnv: string): boolean {
  return nodeEnv === "production";
}

/**
 * A seed password must be at least MIN_SEED_PASSWORD_LENGTH characters
 * and contain upper + lower + digit. Dev defaults are exempt (they are
 * only ever used outside production); operator-supplied values are not.
 */
export function isStrongSeedPassword(value: string): boolean {
  return (
    value.length >= MIN_SEED_PASSWORD_LENGTH &&
    /[a-z]/.test(value) &&
    /[A-Z]/.test(value) &&
    /[0-9]/.test(value)
  );
}

function envPassword(
  raw: string | undefined,
  varName: string
): { value: string; ok: true } | { value: null; ok: false; message: string } {
  if (raw === undefined || raw === "") {
    return { value: null, ok: false, message: "" };
  }
  if (!isStrongSeedPassword(raw)) {
    return {
      value: null,
      ok: false,
      message:
        `${varName} is too weak: it must be at least ${MIN_SEED_PASSWORD_LENGTH} characters ` +
        "and contain uppercase, lowercase and a digit. Generate one with: " +
        "openssl rand -base64 24",
    };
  }
  return { value: raw, ok: true };
}

/**
 * Resolve the passwords the seed will use. Throws with an actionable,
 * secret-free message when the configuration is unsafe — in particular
 * when a privileged admin account would otherwise be created in
 * production without an explicit strong password.
 */
export function resolveSeedPasswords(input: SeedPasswordInput): SeedPasswords {
  const production = isProduction(input.nodeEnv);

  // ---------- Admin accounts (privileged) ----------
  // Evaluated first: failing closed on privileged accounts is the
  // critical safety boundary, so its requirement is reported before
  // any non-privileged concern.
  const adminEnv = envPassword(input.seedAdminPassword, "SEED_ADMIN_PASSWORD");
  let adminPassword: string;
  let adminSource: SeedPasswords["adminSource"];
  if (adminEnv.ok) {
    adminPassword = adminEnv.value;
    adminSource = "env";
  } else if (adminEnv.message) {
    throw new Error(adminEnv.message);
  } else if (production) {
    // Fail closed. There is deliberately NO fallback — not the
    // publicly documented default, and not a generated random value
    // (a random admin password that is never printed would lock the
    // operator out of a fresh deployment with no way to recover it,
    // because recovery codes are self-generated in the profile).
    throw new Error(
      "SEED_ADMIN_PASSWORD is required when NODE_ENV=production. " +
        `It must be at least ${MIN_SEED_PASSWORD_LENGTH} characters with uppercase, ` +
        "lowercase and a digit. Generate one with: openssl rand -base64 24. " +
        "Alternatively, create the first admin through the Super Admin console. " +
        "The seed refuses to create privileged accounts with any default or " +
        "unrecoverable password."
    );
  } else {
    adminPassword = DEV_DEFAULT_ADMIN_PASSWORD;
    adminSource = "dev-default";
  }

  // ---------- Student accounts (non-privileged) ----------
  const studentEnv = envPassword(input.seedStudentPassword, "SEED_STUDENT_PASSWORD");
  let studentPassword: string;
  let studentSource: SeedPasswords["studentSource"];
  if (studentEnv.ok) {
    studentPassword = studentEnv.value;
    studentSource = "env";
  } else if (studentEnv.message) {
    throw new Error(studentEnv.message);
  } else if (!production || input.allowDevSeed) {
    studentPassword = DEV_DEFAULT_STUDENT_PASSWORD;
    studentSource = "dev-default";
  } else {
    throw new Error(
      "SEED_STUDENT_PASSWORD is required when NODE_ENV=production. " +
        "Set it to a strong unique value, or do not seed student accounts in production. " +
        "The documented development default must never exist in a deployed environment."
    );
  }

  return { studentPassword, adminPassword, studentSource, adminSource };
}
