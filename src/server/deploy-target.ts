// Deployment-target guard.
//
// A staging environment must write only to its own database and storage. Copying a
// production env file into a staging preview, or pointing a seed or migration at the wrong
// Supabase project, is the mistake this guards against. The operator pins the project with
//
//   DEPLOY_TARGET=staging | production
//   EXPECTED_SUPABASE_PROJECT_REF=<the project's 20-letter ref>
//
// and the guard then requires every Supabase URL to belong to that project. Pure: no I/O, and
// it returns messages that never include a URL, password or key.
//
// What it cannot do: prove that the pinned project is not production. The operator confirms that
// (STAGING.md §2, step 1). The guard only stops a mismatch.

export const DEPLOY_TARGETS = ["staging", "production"] as const;

export interface DeployTargetInput {
  /** DEPLOY_TARGET */
  deployTarget: string;
  /** EXPECTED_SUPABASE_PROJECT_REF */
  expectedProjectRef: string;
  /** NEXT_PUBLIC_SUPABASE_URL */
  supabaseUrl: string;
  /** DATABASE_URL */
  databaseUrl: string;
  /** DIRECT_URL */
  directUrl: string;
}

export interface DeployTargetResult {
  /** False when neither variable is set: the guard has nothing to enforce. */
  active: boolean;
  problems: string[];
}

const REF_PATTERN = /^[a-z]{20}$/;

function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// Supabase's shared connection pooler. Its host does not name a project; the project is chosen by
// the username suffix (`postgres.<ref>`). So for this host the username is the identity, and it is
// accepted only together with the host check below. A username alone is never enough.
const POOLER_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.pooler\.supabase\.com$/;
const PROJECT_TOKEN = /(?<![a-z])[a-z]{20}(?![a-z])/g;

/**
 * True only when the connection string's host identifies this project:
 *   - the project's own direct host (`db.<ref>.supabase.co`) or API host (`<ref>.supabase.co`), or
 *   - a Supabase pooler host whose username is exactly `postgres.<ref>`.
 * Refused: another project's host even with this project's username; any other 20-letter project
 * token in the username, path or query (for example a routing option); unparseable input.
 */
function connectionTargets(raw: string, ref: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const user = decodeURIComponent(url.username);

    // Any other project named anywhere in the routing parts is a mismatch.
    const routing = `${user} ${decodeURIComponent(url.pathname)} ${decodeURIComponent(url.search)}`;
    for (const token of routing.match(PROJECT_TOKEN) ?? []) {
      if (token !== ref) return false;
    }

    if (host === `db.${ref}.supabase.co` || host === `${ref}.supabase.co`) return true;
    if (POOLER_HOST.test(host)) return user === `postgres.${ref}`;
    return false;
  } catch {
    return false;
  }
}

export function evaluateDeployTarget(input: DeployTargetInput): DeployTargetResult {
  const target = input.deployTarget.trim().toLowerCase();
  const ref = input.expectedProjectRef.trim();
  const active = target !== "" || ref !== "";
  if (!active) return { active: false, problems: [] };

  const problems: string[] = [];
  if (target !== "" && !(DEPLOY_TARGETS as readonly string[]).includes(target)) {
    problems.push('DEPLOY_TARGET must be "staging" or "production".');
  }
  if (target === "staging" && ref === "") {
    problems.push("DEPLOY_TARGET=staging requires EXPECTED_SUPABASE_PROJECT_REF (the staging project's ref).");
  }
  if (ref !== "") {
    if (!REF_PATTERN.test(ref)) {
      problems.push("EXPECTED_SUPABASE_PROJECT_REF must be the 20-character lowercase project ref.");
    } else {
      if (hostOf(input.supabaseUrl) !== `${ref}.supabase.co`) {
        problems.push("NEXT_PUBLIC_SUPABASE_URL does not point at EXPECTED_SUPABASE_PROJECT_REF.");
      }
      if (!connectionTargets(input.databaseUrl, ref)) {
        problems.push("DATABASE_URL does not belong to EXPECTED_SUPABASE_PROJECT_REF.");
      }
      if (!connectionTargets(input.directUrl, ref)) {
        problems.push("DIRECT_URL does not belong to EXPECTED_SUPABASE_PROJECT_REF.");
      }
    }
  }
  return { active, problems };
}

/** Reads the guard inputs from an environment object. */
export function deployTargetInputFromEnv(env: NodeJS.ProcessEnv): DeployTargetInput {
  const v = (k: string) => (env[k] ?? "").trim();
  return {
    deployTarget: v("DEPLOY_TARGET"),
    expectedProjectRef: v("EXPECTED_SUPABASE_PROJECT_REF"),
    supabaseUrl: v("NEXT_PUBLIC_SUPABASE_URL"),
    databaseUrl: v("DATABASE_URL"),
    directUrl: v("DIRECT_URL"),
  };
}
