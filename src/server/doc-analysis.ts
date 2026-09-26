// Server-side document analysis: page/slide counts with safe fallback.
// PDF -> pdf-lib; DOCX/PPTX (ZIP) -> docProps/app.xml (<Pages>/<Slides>); DOC/PPT (OLE2) -> needs review.

import { readHeader, readBuffer } from "./storage";

export interface AnalysisResult {
  pageCount: number | null;
  source: "DOCUMENT_PARSER" | "AI_ANALYSIS" | "ADMIN_VERIFIED" | "USER_CONFIRMED" | null;
  status: "COMPLETED" | "FAILED" | "NEEDS_REVIEW";
  error?: string;
}

const MAX_PDF_BYTES_FOR_PARSE = 120 * 1024 * 1024; // guard rails

export async function analyzeDocument(storageKey: string, ext: string): Promise<AnalysisResult> {
  try {
    if (ext === "pdf") return await analyzePdf(storageKey);
    if (ext === "docx" || ext === "pptx") return await analyzeOoxml(storageKey, ext);
    if (ext === "doc" || ext === "ppt") {
      return {
        pageCount: null,
        source: null,
        status: "NEEDS_REVIEW",
        error: "Legacy binary formats cannot be parsed reliably; administrator review required.",
      };
    }
    return { pageCount: null, source: null, status: "FAILED", error: "Unsupported format" };
  } catch (err) {
    console.error("[doc-analysis]", err instanceof Error ? err.message : err);
    return { pageCount: null, source: null, status: "FAILED", error: "Analysis failed" };
  }
}

// ---------- PDF ----------

async function analyzePdf(storageKey: string): Promise<AnalysisResult> {
  const buf = await readBuffer(storageKey);
  if (buf.length > MAX_PDF_BYTES_FOR_PARSE) {
    return { pageCount: null, source: null, status: "NEEDS_REVIEW", error: "File too large to analyze automatically" };
  }
  try {
    const { PDFDocument } = await import("pdf-lib");
    // pdf-lib may throw on encrypted files; catch and fall back to regex count.
    try {
      const doc = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
      const count = doc.getPageCount();
      if (count > 0) {
        return { pageCount: count, source: "DOCUMENT_PARSER", status: "COMPLETED" };
      }
    } catch {
      // fall through to regex estimate
    }
    // Fallback: count /Type /Page (not /Pages) occurrences in raw bytes.
    const text = buf.toString("latin1");
    const matches = text.match(/\/Type\s*\/Page[^s]/g);
    const count = matches ? matches.length : 0;
    if (count > 0) {
      return { pageCount: count, source: "DOCUMENT_PARSER", status: "COMPLETED" };
    }
    return { pageCount: null, source: null, status: "NEEDS_REVIEW", error: "Could not determine PDF page count" };
  } catch (err) {
    console.error("[doc-analysis] pdf", err instanceof Error ? err.message : err);
    return { pageCount: null, source: null, status: "FAILED", error: "PDF analysis failed" };
  }
}

// ---------- DOCX / PPTX (ZIP container) ----------

async function analyzeOoxml(storageKey: string, ext: string): Promise<AnalysisResult> {
  const buf = await readBuffer(storageKey);

  // Minimal ZIP central-directory walk to find and inflate docProps/app.xml.
  const { inflateRawSync } = await import("zlib");

  // Find End of Central Directory (EOCD)
  const eocdSig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  let eocdIdx = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66_000; i--) {
    if (buf[i] === eocdSig[0] && buf[i + 1] === eocdSig[1] && buf[i + 2] === eocdSig[2] && buf[i + 3] === eocdSig[3]) {
      eocdIdx = i;
      break;
    }
  }
  if (eocdIdx < 0) {
    return { pageCount: null, source: null, status: "NEEDS_REVIEW", error: "Malformed Office document" };
  }
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

    if (name === "docProps/app.xml") {
      // Read local file header to locate compressed data
      if (localOff + 30 > buf.length) break;
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const comp = buf.slice(dataStart, dataStart + compSize);
      const xml = inflateRawSync(comp).toString("utf8");
      const tag = ext === "pptx" ? "Slides" : "Pages";
      const m = xml.match(new RegExp(`<${tag}>(\\d+)</${tag}>`));
      if (m) {
        const count = parseInt(m[1], 10);
        if (count > 0 && count < 100_000) {
          return { pageCount: count, source: "DOCUMENT_PARSER", status: "COMPLETED" };
        }
      }
      return { pageCount: null, source: null, status: "NEEDS_REVIEW", error: "Document metadata missing page count" };
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return { pageCount: null, source: null, status: "NEEDS_REVIEW", error: "Document metadata not found" };
}
