// Server-side document analysis: page/slide counts with explicit review states.
//
// Accuracy rules (important for pricing integrity):
//  * A count produced by a real document parser (pdf-lib page tree, PPTX slide
//    parts) is authoritative -> COMPLETED.
//  * A count produced by a heuristic (raw-byte /Type /Page counting, rendered-page
//    -break counting) is an ESTIMATE -> NEEDS_REVIEW. It is never presented as
//    verified, and ordering stays blocked until an administrator or the student
//    confirms it (see `confirmFilePageCount`).

import { inflateRawSync } from "zlib";
import { readHeader, readBuffer } from "./storage";

export interface AnalysisResult {
  pageCount: number | null;
  source: "DOCUMENT_PARSER" | "AI_ANALYSIS" | "ADMIN_VERIFIED" | "USER_CONFIRMED" | null;
  status: "COMPLETED" | "FAILED" | "NEEDS_REVIEW";
  error?: string;
}

const MAX_PDF_BYTES_FOR_PARSE = 120 * 1024 * 1024; // guard rails
const MAX_OOXML_BYTES_FOR_PARSE = 120 * 1024 * 1024;
const MAX_PAGE_COUNT = 100_000;

export async function analyzeDocument(storageKey: string, ext: string): Promise<AnalysisResult> {
  try {
    if (ext === "pdf") return await analyzePdf(storageKey);
    if (ext === "docx" || ext === "pptx") return await analyzeOoxml(storageKey, ext);
    if (ext === "doc" || ext === "ppt") {
      return {
        pageCount: null,
        source: null,
        status: "NEEDS_REVIEW",
        error:
          "Legacy binary formats (.doc/.ppt) cannot be parsed reliably. Enter the page count to confirm it, or ask the print desk to verify the document.",
      };
    }
    return { pageCount: null, source: null, status: "FAILED", error: "Unsupported format" };
  } catch (err) {
    console.error("[doc-analysis]", err instanceof Error ? err.message : err);
    return { pageCount: null, source: null, status: "FAILED", error: "Analysis failed" };
  }
}

// ---------- PDF ----------

/**
 * Heuristic page count by counting `/Type /Page` (but not `/Type /Pages`) tokens in
 * the raw bytes. Used only when the PDF cannot be parsed (encrypted, truncated,
 * linearised oddities). Exported for tests; callers must treat the result as an
 * unverified estimate.
 */
export function estimatePdfPageCountFromBytes(bytes: Uint8Array): number {
  const text = Buffer.from(bytes).toString("latin1");
  const matches = text.match(/\/Type\s*\/Page[^s]/g);
  return matches ? matches.length : 0;
}

async function analyzePdf(storageKey: string): Promise<AnalysisResult> {
  const buf = await readBuffer(storageKey);
  if (buf.length > MAX_PDF_BYTES_FOR_PARSE) {
    return { pageCount: null, source: null, status: "NEEDS_REVIEW", error: "File too large to analyze automatically" };
  }
  try {
    const { PDFDocument } = await import("pdf-lib");
    try {
      const doc = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
      const count = doc.getPageCount();
      if (count > 0 && count < MAX_PAGE_COUNT) {
        return { pageCount: count, source: "DOCUMENT_PARSER", status: "COMPLETED" };
      }
    } catch {
      // fall through to the heuristic estimate
    }

    // The parser could not read the page tree (encrypted / damaged / unusual
    // linearisation). A raw-token count can under- or over-count, so it is reported
    // as an ESTIMATE that needs confirmation -- never as a verified page count.
    const estimate = estimatePdfPageCountFromBytes(buf);
    if (estimate > 0 && estimate < MAX_PAGE_COUNT) {
      return {
        pageCount: estimate,
        source: null,
        status: "NEEDS_REVIEW",
        error: `Could not read this PDF's page tree, so ${estimate} page(s) is only an estimate. Please confirm the page count before ordering.`,
      };
    }
    return {
      pageCount: null,
      source: null,
      status: "NEEDS_REVIEW",
      error: "Could not determine PDF page count. Enter the page count to confirm it.",
    };
  } catch (err) {
    console.error("[doc-analysis] pdf", err instanceof Error ? err.message : err);
    return { pageCount: null, source: null, status: "FAILED", error: "PDF analysis failed" };
  }
}

// ---------- DOCX / PPTX (ZIP container) ----------

const EOCD_SIG = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const EOCD_SEARCH_WINDOW = 66_000;

function findEocd(buf: Buffer): number {
  for (let i = buf.length - 22; i >= 0 && i > buf.length - EOCD_SEARCH_WINDOW; i--) {
    if (
      buf[i] === EOCD_SIG[0] &&
      buf[i + 1] === EOCD_SIG[1] &&
      buf[i + 2] === EOCD_SIG[2] &&
      buf[i + 3] === EOCD_SIG[3]
    ) {
      return i;
    }
  }
  return -1;
}

/** Minimal ZIP central-directory walk. Returns local-header offsets by entry name. */
export function listZipEntries(buf: Buffer): Map<string, { localOffset: number; compressedSize: number }> {
  const entries = new Map<string, { localOffset: number; compressedSize: number }>();
  const eocdIdx = findEocd(buf);
  if (eocdIdx < 0) return entries;

  const entryCount = buf.readUInt16LE(eocdIdx + 10);
  let offset = buf.readUInt32LE(eocdIdx + 16);

  for (let n = 0; n < entryCount; n++) {
    if (offset + 46 > buf.length) break;
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOff = buf.readUInt32LE(offset + 42);
    const name = buf.slice(offset + 46, offset + 46 + nameLen).toString("utf8");
    entries.set(name, { localOffset: localOff, compressedSize: compSize });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Inflate one entry from a ZIP buffer, or null when it cannot be read safely. */
export function readZipEntry(buf: Buffer, entries: ReturnType<typeof listZipEntries>, name: string): string | null {
  const entry = entries.get(name);
  if (!entry) return null;
  const { localOffset, compressedSize } = entry;
  if (localOffset + 30 > buf.length) return null;
  const lNameLen = buf.readUInt16LE(localOffset + 26);
  const lExtraLen = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + lNameLen + lExtraLen;
  if (dataStart < 0 || dataStart + compressedSize > buf.length) return null;
  try {
    return inflateRawSync(buf.subarray(dataStart, dataStart + compressedSize)).toString("utf8");
  } catch {
    return null;
  }
}

/** Count `ppt/slides/slideN.xml` parts — authoritative for PPTX. */
export function countPptxSlides(entries: ReturnType<typeof listZipEntries>): number {
  let n = 0;
  for (const name of entries.keys()) {
    if (/^ppt\/slides\/slide\d+\.xml$/i.test(name)) n++;
  }
  return n;
}

/** Estimate DOCX pages from explicit/rendered page breaks when metadata is absent. */
export function estimateDocxPagesFromBreaks(documentXml: string): number {
  const explicit = documentXml.match(/<w:br[^>]*w:type="page"[^>]*\/?>/g);
  const rendered = documentXml.match(/<w:lastRenderedPageBreak[^>]*\/?>/g);
  const breaks = (explicit?.length ?? 0) + (rendered?.length ?? 0);
  return breaks + 1;
}

async function analyzeOoxml(storageKey: string, ext: string): Promise<AnalysisResult> {
  const buf = await readBuffer(storageKey);
  if (buf.length > MAX_OOXML_BYTES_FOR_PARSE) {
    return { pageCount: null, source: null, status: "NEEDS_REVIEW", error: "File too large to analyze automatically" };
  }

  const entries = listZipEntries(buf);
  if (entries.size === 0) {
    return { pageCount: null, source: null, status: "NEEDS_REVIEW", error: "Malformed Office document" };
  }

  // PPTX: the slide parts are the authoritative source of truth.
  if (ext === "pptx") {
    const slides = countPptxSlides(entries);
    if (slides > 0 && slides < MAX_PAGE_COUNT) {
      return { pageCount: slides, source: "DOCUMENT_PARSER", status: "COMPLETED" };
    }
  }

  // docProps/app.xml carries <Pages> (docx) / <Slides> (pptx) written by Word and
  // PowerPoint. It is frequently missing for files produced by other tools.
  const appXml = readZipEntry(buf, entries, "docProps/app.xml");
  if (appXml) {
    const tag = ext === "pptx" ? "Slides" : "Pages";
    const m = appXml.match(new RegExp(`<${tag}>(\\d+)</${tag}>`));
    if (m) {
      const count = parseInt(m[1], 10);
      if (count > 0 && count < MAX_PAGE_COUNT) {
        return { pageCount: count, source: "DOCUMENT_PARSER", status: "COMPLETED" };
      }
    }
  }

  // DOCX fallback: count page breaks in the body. This is an estimate because
  // pagination depends on fonts, paper size and margins at print time.
  if (ext === "docx") {
    const documentXml = readZipEntry(buf, entries, "word/document.xml");
    if (documentXml) {
      const estimate = estimateDocxPagesFromBreaks(documentXml);
      if (estimate > 0 && estimate < MAX_PAGE_COUNT) {
        return {
          pageCount: estimate,
          source: null,
          status: "NEEDS_REVIEW",
          error: `Page count is not stored in this document, so ${estimate} page(s) is an estimate from page breaks. Please confirm the page count before ordering.`,
        };
      }
    }
    return {
      pageCount: null,
      source: null,
      status: "NEEDS_REVIEW",
      error: "Document metadata missing page count. Enter the page count to confirm it.",
    };
  }

  return {
    pageCount: null,
    source: null,
    status: "NEEDS_REVIEW",
    error: "Could not count slides in this presentation. Enter the page count to confirm it.",
  };
}
