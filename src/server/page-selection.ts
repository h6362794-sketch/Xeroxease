// Page-selection parsing: "1-5, 8, 10-15" -> ordered unique page list, validated against total.

export interface PageSelectionResult {
  pages: number[]; // ordered, unique
  error?: string;
}

export function parsePageSelection(
  selection: string,
  totalPages: number
): PageSelectionResult {
  const s = selection.trim();
  if (!s || /^all$/i.test(s)) {
    return { pages: Array.from({ length: totalPages }, (_, i) => i + 1) };
  }
  if (!/^[0-9,\s\-]+$/.test(s)) {
    return { pages: [], error: "Invalid page selection format" };
  }
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  const pages = new Set<number>();
  for (const part of parts) {
    const m = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) return { pages: [], error: `Invalid page range: "${part}"` };
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    if (a < 1 || b < a) return { pages: [], error: `Invalid page range: "${part}"` };
    if (b > totalPages) {
      return { pages: [], error: `Page ${b} exceeds document total (${totalPages})` };
    }
    for (let i = a; i <= b; i++) pages.add(i);
  }
  const ordered = Array.from(pages).sort((x, y) => x - y);
  if (ordered.length === 0) return { pages: [], error: "No pages selected" };
  return { pages: ordered };
}

/** Count of pages for custom selection (already validated). */
export function countSelectedPages(selection: string, totalPages: number): number {
  const r = parsePageSelection(selection, totalPages);
  return r.error ? 0 : r.pages.length;
}
