import { prisma } from "@/lib/prisma";

export interface AppSettings {
  paymentQrEnabled: boolean;
  paymentQrStorageKey: string | null;
  paymentQrMime: string | null;
  paymentQrFileName: string | null;
  paymentInstructions: string;
  paymentAccountDisplay: string;
  cancellationAllowedStatuses: string[];
  retentionDays: number;
  queuePagesPerHour: number;
}

const DEFAULTS: AppSettings = {
  paymentQrEnabled: false,
  paymentQrStorageKey: null,
  paymentQrMime: null,
  paymentQrFileName: null,
  paymentInstructions:
    "Scan the QR code with any UPI app, complete the payment, then submit the transaction reference below. Payment will be confirmed after verification by the XeroxEase desk.",
  paymentAccountDisplay: "XeroxEase Print Desk",
  cancellationAllowedStatuses: [
    "ORDER_PLACED",
    "PAYMENT_PENDING",
    "PAYMENT_UNDER_REVIEW",
  ],
  retentionDays: 30,
  queuePagesPerHour: 900,
};

const KEY = "app";

export async function getSettings(): Promise<AppSettings> {
  const row = await prisma.setting.findUnique({ where: { key: KEY } });
  if (!row) return { ...DEFAULTS };
  const v = (row.value ?? {}) as Partial<AppSettings>;
  return {
    ...DEFAULTS,
    ...v,
    cancellationAllowedStatuses:
      v.cancellationAllowedStatuses ?? DEFAULTS.cancellationAllowedStatuses,
  };
}

export async function updateSettings(patch: Partial<AppSettings>, updatedBy?: string): Promise<AppSettings> {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await prisma.setting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: next as never, updatedBy },
    update: { value: next as never, updatedBy },
  });
  return next;
}

export async function getPriceTable(): Promise<Record<string, number>> {
  const rows = await prisma.pricingConfig.findMany({ where: { isActive: true } });
  const table: Record<string, number> = {};
  for (const r of rows) table[r.key] = Number(r.unitPrice);
  return table;
}
