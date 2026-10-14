import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/server/auth";
import { registerSchema } from "@/server/validation";
import { apiError, enforceRateLimit, json, parseBody, withErrorHandling } from "@/server/api-utils";
import { RATE_LIMITS } from "@/server/rate-limit";
import { audit } from "@/server/audit";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const limited = await enforceRateLimit(req, RATE_LIMITS.register, "register");
    if (limited) return limited;

    const data = await parseBody(req, registerSchema);

    const emailNorm = data.email.toLowerCase();
    const phone = data.phone.replace(/[\s-]/g, "");
    const regNo = data.regNo.toUpperCase();

    // Duplicate prevention (email / phone / reg number)
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

    const user = await prisma.user.create({
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

    await audit({
      actorId: user.id,
      actorRole: "STUDENT",
      action: "USER_REGISTERED",
      targetType: "USER",
      targetId: user.id,
    });

    return json({ ok: true }, { status: 201 });
  });
}

export const dynamic = "force-dynamic";
