import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/server/auth";
import { registerSchema } from "@/server/validation";
import { apiError, enforceRateLimit, json, parseBody, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { audit } from "@/server/audit";

/**
 * Map a Prisma unique-constraint failure (P2002) to the same
 * client-facing conflict response the preflight check returns.
 * The preflight query and the insert are not atomic, so two
 * concurrent registrations can pass the preflight and collide on
 * the insert; the constraint is the source of truth, so this path
 * must produce a 409 — never a raw 500 with database internals.
 */
function conflictMessageFor(err: unknown): string | null {
  if (typeof err !== "object" || err === null || (err as { code?: string }).code !== "P2002") {
    return null;
  }
  const target = (err as { meta?: { target?: unknown } }).meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : target ? [String(target)] : [];
  if (fields.some((f) => f === "email_norm" || f === "email")) {
    return "An account with this email already exists.";
  }
  if (fields.some((f) => f === "phone")) {
    return "An account with this phone number already exists.";
  }
  if (fields.some((f) => f === "reg_no" || f === "regNo")) {
    return "An account with this registration number already exists.";
  }
  // Unknown unique constraint: still a conflict, but do not guess
  // which field or echo database details.
  return "An account with these details already exists.";
}

export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const limited = await enforceRateLimit(req, RATE_LIMITS.register, "register");
    if (limited) return limited;

    const data = await parseBody(req, registerSchema);

    const emailNorm = data.email.toLowerCase();
    const phone = data.phone.replace(/[\s-]/g, "");
    const regNo = data.regNo.toUpperCase();

    // Duplicate prevention (email / phone / reg number). This is a
    // fast path only — the database unique constraints below are the
    // final authority, and their failures are mapped to the same
    // 409 responses.
    const dup = await prisma.user.findFirst({
      where: {
        OR: [{ emailNorm }, { phone }, { regNo }],
      },
      select: { emailNorm: true, phone: true, regNo: true },
    });
    if (dup) {
      if (dup.emailNorm === emailNorm) return apiError("An account with this email already exists.", 409);
      if (dup.phone === phone) return apiError("An account with this phone number already exists.", 409);
      return apiError("An account with this registration number already exists.", 409);
    }

    const { hash } = await hashPassword(data.password);

    let user: { id: string };
    try {
      user = await prisma.user.create({
        data: {
          name: data.name,
          email: data.email,
          emailNorm,
          phone,
          regNo,
          branch: data.branch,
          section: data.section,
          year: data.year,
          passwordHash: hash,
          role: "STUDENT", // never trust client role
        },
        select: { id: true },
      });
    } catch (err) {
      const message = conflictMessageFor(err);
      if (message) return apiError(message, 409);
      throw err;
    }

    await audit({
      actorId: user.id,
      actorRole: "STUDENT",
      action: "USER_REGISTERED",
      targetType: "USER",
      targetId: user.id,
    });

    // No session is created here: registration is followed by an
    // explicit sign-in, which the login-page banner tells the user.
    return json({ ok: true }, { status: 201 });
  });
}

export const dynamic = "force-dynamic";
