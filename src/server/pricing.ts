// Pure pricing engine — server is the source of truth.
// Prices come exclusively from the PricingConfig table (never the client).

export type PriceTable = Record<string, number>; // e.g. { A4_BW: 1.5, A4_COLOR: 8, STAPLE: 5 }

export interface PriceInput {
  paperSize: "A4" | "LEGAL";
  colorMode: "BW" | "COLOR";
  sides: "SINGLE" | "DOUBLE";
  copies: number;
  totalPages: number; // verified page count after page-selection
  finishing: string[]; // STAPLE | SPIRAL | STICK_FILE
  pageSelection: "ALL" | "CUSTOM";
}

export interface PriceResult {
  pricePerPage: number;
  printCost: number;
  finishingFee: number;
  total: number;
  billablePages: number;
}

export function pricingKey(paperSize: string, colorMode: string): string {
  return `${paperSize}_${colorMode === "COLOR" ? "COLOR" : "BW"}`;
}

/** Effective printed sheets: double-side halves sheet usage (ceil), min 1. */
export function computeSheets(totalPages: number, sides: "SINGLE" | "DOUBLE"): number {
  if (!Number.isFinite(totalPages) || totalPages <= 0) return 0;
  return sides === "DOUBLE" ? Math.ceil(totalPages / 2) : totalPages;
}

export function calculatePrice(input: PriceInput, table: PriceTable): PriceResult {
  const copies = Math.max(1, Math.floor(input.copies) || 1);
  const totalPages = Math.max(0, Math.floor(input.totalPages) || 0);
  const sheets = computeSheets(totalPages, input.sides);
  const billablePages = sheets * copies;

  const key = pricingKey(input.paperSize, input.colorMode);
  const pricePerPage = table[key] ?? 0;

  const printCost = round2(billablePages * pricePerPage);

  let finishingFee = 0;
  for (const f of input.finishing) {
    finishingFee += table[f] ?? 0;
  }
  finishingFee = round2(finishingFee);

  const total = round2(printCost + finishingFee);
  return { pricePerPage, printCost, finishingFee, total, billablePages };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
