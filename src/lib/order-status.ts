// Pure order-status state machine.
//
// Kept free of any Prisma / database import on purpose: it encodes business rules
// that must be unit-testable in isolation (and were previously only reachable
// through `@/server/orders`, which drags in the database client and made the
// `tests/order-rules.test.ts` suite fail on a checkout where Prisma Client had
// not been generated yet).

import { ORDER_TRANSITIONS } from "./constants";

/** Actors allowed to move orders between states. Students may never do so. */
const ALLOWED_STATUS_ACTORS: Record<string, string[]> = {
  ADMIN: ["*"],
  SUPER_ADMIN: ["*"],
  STUDENT: [],
};

export function canActorChangeStatus(role: string): boolean {
  return ALLOWED_STATUS_ACTORS[role]?.includes("*") ?? false;
}

/** Unknown source states never allow a transition (no implicit wildcard). */
export function isTransitionAllowed(from: string, to: string): boolean {
  return (ORDER_TRANSITIONS[from] || []).includes(to);
}
