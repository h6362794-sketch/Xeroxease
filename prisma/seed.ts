/* XeroxEase seed — development data only.
 * Dev credentials (documented in SEED.md) — production must rotate these.
 * Run: npm run db:seed
 */
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { readFileSync } from "fs";
import path from "path";

const prisma = new PrismaClient();

const DEV_STUDENT_PASSWORD = "Student@123";
const DEV_ADMIN_PASSWORD = "Admin@123";

async function main() {
  console.log("Seeding XeroxEase development data…");

  // ---------- Pricing ----------
  const pricing = [
    { key: "A4_BW", label: "A4 Black & White", category: "PRINT", unitPrice: 2, unit: "page" },
    { key: "A4_COLOR", label: "A4 Colour", category: "PRINT", unitPrice: 8, unit: "page" },
    { key: "LEGAL_BW", label: "Legal Black & White", category: "PRINT", unitPrice: 3, unit: "page" },
    { key: "LEGAL_COLOR", label: "Legal Colour", category: "PRINT", unitPrice: 10, unit: "page" },
    { key: "STAPLE", label: "Staple", category: "FINISHING", unitPrice: 5, unit: "item" },
    { key: "SPIRAL", label: "Spiral Binding", category: "FINISHING", unitPrice: 40, unit: "item" },
    { key: "STICK_FILE", label: "Stick File", category: "FINISHING", unitPrice: 25, unit: "item" },
  ];
  for (const p of pricing) {
    await prisma.pricingConfig.upsert({ where: { key: p.key }, create: p, update: { unitPrice: p.unitPrice } });
  }

  // ---------- Users ----------
  const studentHash = await argon2.hash(DEV_STUDENT_PASSWORD, { type: argon2.argon2id });
  const adminHash = await argon2.hash(DEV_ADMIN_PASSWORD, { type: argon2.argon2id });

  const student = await prisma.user.upsert({
    where: { emailNorm: "student@college.edu" },
    create: {
      email: "student@college.edu",
      emailNorm: "student@college.edu",
      phone: "9876543210",
      passwordHash: studentHash,
      name: "Demo Student",
      regNo: "RA2211003010001",
      branch: "CSE",
      section: "A",
      year: 3,
      role: "STUDENT",
      emailVerified: true,
    },
    update: {},
  });
  const student2 = await prisma.user.upsert({
    where: { emailNorm: "student2@college.edu" },
    create: {
      email: "student2@college.edu",
      emailNorm: "student2@college.edu",
      phone: "9876543211",
      passwordHash: studentHash,
      name: "Demo Student 2",
      regNo: "RA2211003010002",
      branch: "ECE",
      section: "B",
      year: 2,
      role: "STUDENT",
      emailVerified: true,
    },
    update: {},
  });
  const admin = await prisma.user.upsert({
    where: { emailNorm: "admin@xeroxease.local" },
    create: {
      email: "admin@xeroxease.local",
      emailNorm: "admin@xeroxease.local",
      passwordHash: adminHash,
      name: "Print Desk Admin",
      role: "ADMIN",
      emailVerified: true,
    },
    update: {},
  });
  const superAdmin = await prisma.user.upsert({
    where: { emailNorm: "superadmin@xeroxease.local" },
    create: {
      email: "superadmin@xeroxease.local",
      emailNorm: "superadmin@xeroxease.local",
      passwordHash: adminHash,
      name: "Super Admin",
      role: "SUPER_ADMIN",
      emailVerified: true,
    },
    update: {},
  });

  // ---------- Settings ----------
  await prisma.setting.upsert({
    where: { key: "app" },
    create: {
      key: "app",
      value: {
        paymentQrEnabled: false,
        paymentQrStorageKey: null,
        paymentQrMime: null,
        paymentQrFileName: null,
        paymentInstructions:
          "Scan the QR with any UPI app, pay the exact amount, then submit the transaction reference. The XeroxEase desk verifies payments during working hours.",
        paymentAccountDisplay: "XeroxEase Print Desk",
        cancellationAllowedStatuses: ["ORDER_PLACED", "PAYMENT_PENDING", "PAYMENT_UNDER_REVIEW"],
        retentionDays: 30,
        queuePagesPerHour: 900,
      } as never,
      updatedBy: superAdmin.id,
    },
    update: {},
  });

  // ---------- Demo orders ----------
  const existing = await prisma.order.count();
  if (existing === 0) {
    const o1 = await prisma.order.create({
      data: {
        orderNumber: "XE-2026-000001",
        userId: student.id,
        paperSize: "A4",
        colorMode: "BW",
        sides: "DOUBLE",
        copies: 1,
        pageSelection: "ALL",
        totalPages: 40,
        billablePages: 20,
        pricePerPage: 2,
        finishingFee: 5,
        totalAmount: 45,
        status: "READY_FOR_COLLECTION",
        paymentStatus: "PAYMENT_CONFIRMED",
        paymentRef: "UPI-DEMO-001",
        paymentVerifiedBy: admin.id,
        paymentVerifiedAt: new Date(),
        completedAt: null,
      },
    });
    await prisma.orderEvent.create({
      data: {
        orderId: o1.id,
        type: "ORDER_PLACED",
        toStatus: "PAYMENT_PENDING",
        message: "Demo order created by seed.",
        actorId: student.id,
        actorRole: "STUDENT",
      },
    });
    const o2 = await prisma.order.create({
      data: {
        orderNumber: "XE-2026-000002",
        userId: student2.id,
        paperSize: "A4",
        colorMode: "COLOR",
        sides: "SINGLE",
        copies: 2,
        pageSelection: "ALL",
        totalPages: 12,
        billablePages: 24,
        pricePerPage: 8,
        finishingFee: 0,
        totalAmount: 192,
        status: "COMPLETED",
        paymentStatus: "PAYMENT_CONFIRMED",
        paymentRef: "UPI-DEMO-002",
        paymentVerifiedBy: admin.id,
        paymentVerifiedAt: new Date(),
        completedAt: new Date(),
      },
    });
    await prisma.feedback.create({
      data: { orderId: o2.id, userId: student2.id, rating: 5, comment: "Super fast, loved it!" },
    });
    console.log("Created demo orders XE-2026-000001, XE-2026-000002");
  }

  console.log("\n--- Development credentials (DEV ONLY) ---");
  console.log(`Student     : student@college.edu / ${DEV_STUDENT_PASSWORD}`);
  console.log(`Student 2   : student2@college.edu / ${DEV_STUDENT_PASSWORD}`);
  console.log(`Admin       : admin@xeroxease.local / ${DEV_ADMIN_PASSWORD}`);
  console.log(`Super Admin : superadmin@xeroxease.local / ${DEV_ADMIN_PASSWORD}`);
  console.log("Rotate these immediately in any non-dev environment.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
