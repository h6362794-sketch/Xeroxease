// Validation for Super Admin settings that govern order-state behaviour. Pure: no database
// import, so the rules are unit-testable on their own.

import { z } from "zod";
import { CANCELLABLE_STATUSES } from "./constants";

/**
 * A status a student may be allowed to cancel from. Only built-in cancellable states are
 * accepted: terminal states, printing and collection states are never listed, and nothing can
 * be listed that the state machine would refuse to move to CANCELLED.
 */
export const cancellationStatusSchema = z
  .string()
  .refine((s) => (CANCELLABLE_STATUSES as readonly string[]).includes(s), {
    message: "Only statuses a student can cancel from can be listed.",
  });

export const settingsPatchSchema = z.object({
  paymentInstructions: z.string().max(1000).optional(),
  paymentAccountDisplay: z.string().max(120).optional(),
  retentionDays: z.coerce.number().int().min(1).max(3650).optional(),
  queuePagesPerHour: z.coerce.number().int().min(50).max(100000).optional(),
  cancellationAllowedStatuses: z.array(cancellationStatusSchema).max(12).optional(),
});
