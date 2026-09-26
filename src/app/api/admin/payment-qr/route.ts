import { prisma } from "@/lib/prisma";
import { requireRole } from "@/server/auth";
import { apiError, json, withErrorHandling } from "@/server/api-utils";
import { getSettings, updateSettings } from "@/server/settings";
import { buildStorageKey, saveBuffer, deleteFile } from "@/server/storage";
import { audit } from "@/server/audit";
import { writeFile } from "fs/promises";

const MAX_QR_SIZE = 5 * 1024 * 1024; // 5 MB
const ALLOWED_QR_MIMES = ["image/png", "image/jpeg", "image/webp"];

export async function GET() {
  return withErrorHandling(async () => {
    await requireRole("SUPER_ADMIN");
    const s = await getSettings();
    return json({
      enabled: s.paymentQrEnabled,
      fileName: s.paymentQrFileName,
      mime: s.paymentQrMime,
      hasQr: Boolean(s.paymentQrStorageKey),
      instructions: s.paymentInstructions,
      accountDisplay: s.paymentAccountDisplay,
    });
  });
}

export async function POST(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireRole("SUPER_ADMIN");

    const form = await req.formData();
    const file = form.get("qr");
    if (!(file instanceof File)) return apiError("No QR image provided.", 400);
    if (file.size > MAX_QR_SIZE) return apiError("QR image must be under 5 MB.", 413);
    if (!ALLOWED_QR_MIMES.includes(file.type)) {
      return apiError("QR must be a PNG, JPEG or WebP image.", 415);
    }

    const buf = Buffer.from(await file.arrayBuffer());
    // Basic magic-byte check for images
    const isPng = buf[0] === 0x89 && buf[1] === 0x50;
    const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
    const isWebp = buf.toString("latin1", 0, 4) === "RIFF";
    if (!isPng && !isJpg && !isWebp) return apiError("File is not a valid image.", 415);

    const storageKey = buildStorageKey("system", `payment-qr-${Date.now()}`);
    await saveBuffer(storageKey, buf);

    const prev = await getSettings();
    if (prev.paymentQrStorageKey && prev.paymentQrStorageKey !== storageKey) {
      await deleteFile(prev.paymentQrStorageKey);
    }

    await updateSettings(
      {
        paymentQrEnabled: true,
        paymentQrStorageKey: storageKey,
        paymentQrMime: file.type,
        paymentQrFileName: file.name.slice(0, 120),
      },
      user.id
    );

    await audit({
      actorId: user.id,
      actorRole: user.role,
      action: "PAYMENT_QR_UPLOADED",
      targetType: "SETTINGS",
      metadata: { fileName: file.name.slice(0, 120), size: buf.length },
    });

    return json({ ok: true });
  });
}

export async function PATCH(req: Request) {
  return withErrorHandling(async () => {
    const user = await requireRole("SUPER_ADMIN");
    const body = (await req.json().catch(() => ({}))) as { enabled?: boolean };
    if (typeof body.enabled === "boolean") {
      await updateSettings({ paymentQrEnabled: body.enabled }, user.id);
      await audit({
        actorId: user.id,
        actorRole: user.role,
        action: body.enabled ? "PAYMENT_QR_ENABLED" : "PAYMENT_QR_DISABLED",
        targetType: "SETTINGS",
      });
    }
    return json({ ok: true });
  });
}

export async function DELETE() {
  return withErrorHandling(async () => {
    const user = await requireRole("SUPER_ADMIN");
    const s = await getSettings();
    if (s.paymentQrStorageKey) await deleteFile(s.paymentQrStorageKey);
    await updateSettings(
      { paymentQrEnabled: false, paymentQrStorageKey: null, paymentQrMime: null, paymentQrFileName: null },
      user.id
    );
    await audit({ actorId: user.id, actorRole: user.role, action: "PAYMENT_QR_REMOVED", targetType: "SETTINGS" });
    return json({ ok: true });
  });
}

export const dynamic = "force-dynamic";
