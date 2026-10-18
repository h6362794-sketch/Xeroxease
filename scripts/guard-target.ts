/* eslint-disable no-console */
/**
 * Deployment-target guard, as a standalone command. Run it before any command that writes to a
 * database (`prisma migrate deploy`, `db:seed`) so a mismatched project stops the run.
 *
 * Usage (values loaded into the shell from the secret manager, never typed into a file):
 *   npm run guard:target
 *
 * Exits 0 when no target is pinned or the pin matches; 1 with the names of the failing checks.
 * It never prints a URL, password or key.
 */
import { deployTargetInputFromEnv, evaluateDeployTarget } from "../src/server/deploy-target";

const result = evaluateDeployTarget(deployTargetInputFromEnv(process.env));

if (!result.active) {
  console.log("No deployment target is pinned (DEPLOY_TARGET and EXPECTED_SUPABASE_PROJECT_REF are unset).");
  console.log("Set both on a staging deployment to enforce the guard.");
  process.exit(0);
}

if (result.problems.length > 0) {
  console.error("Deployment target guard FAILED. Nothing was written.");
  for (const p of result.problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log("Deployment target guard passed: database and Supabase URLs belong to the pinned project.");
