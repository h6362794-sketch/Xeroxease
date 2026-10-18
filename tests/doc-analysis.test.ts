import { describe, it, expect, vi, beforeEach } from "vitest";
import { deflateRawSync } from "zlib";

/**
 * Document-analysis regression tests.
 *
 * The important rule under test: a heuristic page count (raw-byte /Type /Page
 * counting, rendered page-break counting) must NEVER be reported as a verified
 * COMPLETED result. It previously was, which let an estimate be priced as fact.
 */

// ---------- tiny ZIP builder (enough for an OOXML container) ----------

function crc32(buf: Buffer): number {
  let c: number;
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.from(content, "utf8");
    const comp = deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + comp.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

let stored: Buffer | null = null;

vi.mock("@/server/storage", () => ({
  readBuffer: async () => {
    if (!stored) throw new Error("no file");
    return stored;
  },
  readHeader: async () => stored?.subarray(0, 16) ?? Buffer.alloc(0),
}));

let docAnalysis: typeof import("@/server/doc-analysis");

beforeEach(async () => {
  stored = null;
  vi.resetModules();
  docAnalysis = await import("@/server/doc-analysis");
});

describe("PDF page-count heuristic", () => {
  it("counts /Type /Page but not /Type /Pages", () => {
    const bytes = Buffer.from(
      "/Type /Pages /Kids [] /Type /Page 1 0 R /Type /Page 2 0 R /Type /Page 3 0 R",
      "latin1"
    );
    expect(docAnalysis.estimatePdfPageCountFromBytes(bytes)).toBe(3);
  });

  it("returns 0 for a PDF with no page objects", () => {
    expect(docAnalysis.estimatePdfPageCountFromBytes(Buffer.from("%PDF-1.7 trailer", "latin1"))).toBe(0);
  });
});

describe("DOCX / PPTX analysis", () => {
  it("reads the authoritative <Pages> value from docProps/app.xml", async () => {
    stored = buildZip({
      "docProps/app.xml": '<?xml version="1.0"?><Properties><Pages>17</Pages></Properties>',
      "word/document.xml": "<w:document><w:body/></w:document>",
    });
    const res = await docAnalysis.analyzeDocument("k", "docx");
    expect(res.status).toBe("COMPLETED");
    expect(res.pageCount).toBe(17);
    expect(res.source).toBe("DOCUMENT_PARSER");
  });

  it("counts ppt/slides/slideN.xml parts for PPTX", async () => {
    stored = buildZip({
      "ppt/slides/slide1.xml": "<s/>",
      "ppt/slides/slide2.xml": "<s/>",
      "ppt/slides/slide3.xml": "<s/>",
      "docProps/app.xml": "<Properties/>", // no <Slides> metadata
    });
    const res = await docAnalysis.analyzeDocument("k", "pptx");
    expect(res.status).toBe("COMPLETED");
    expect(res.pageCount).toBe(3);
  });

  it("marks the page-break estimate as NEEDS_REVIEW instead of verified", async () => {
    // Google Docs / LibreOffice exports frequently omit <Pages> entirely.
    stored = buildZip({
      "docProps/app.xml": "<Properties><Words>900</Words></Properties>",
      "word/document.xml":
        "<w:document><w:body>a<w:br w:type=\"page\"/>b<w:br w:type=\"page\"/>c</w:body></w:document>",
    });
    const res = await docAnalysis.analyzeDocument("k", "docx");
    expect(res.status).toBe("NEEDS_REVIEW");
    expect(res.source).toBeNull();
    expect(res.pageCount).toBe(3);
    expect(res.error).toMatch(/estimate/i);
  });

  it("reports a malformed container as needing review", async () => {
    stored = Buffer.from("not a zip file at all");
    const res = await docAnalysis.analyzeDocument("k", "docx");
    expect(res.status).toBe("NEEDS_REVIEW");
    expect(res.pageCount).toBeNull();
  });

  it("treats corrupt local-header offsets safely", async () => {
    const zip = buildZip({ "docProps/app.xml": "<Properties><Pages>4</Pages></Properties>" });
    // Truncate the file so central-directory offsets point past the end.
    stored = zip.subarray(0, Math.max(0, zip.length - 80));
    const res = await docAnalysis.analyzeDocument("k", "docx");
    // Must not throw; must not claim a verified count.
    expect(res.status === "NEEDS_REVIEW" || res.status === "FAILED").toBe(true);
  });
});

describe("decompression bombs", () => {
  // A few KB of deflate can inflate to gigabytes. Office XML parts are a few KB to a few
  // MB in practice, so the analyzer must cap what it will inflate instead of trusting the
  // archive. Without a cap this test allocates ~20 MB per entry and, for a hostile file,
  // grows until the Node process runs out of memory.
  it("does not inflate an oversized XML part and falls back to review", async () => {
    stored = buildZip({
      // Planted metadata that a successful inflate would trust (COMPLETED, 999 pages).
      "docProps/app.xml": "<Properties><Pages>999</Pages></Properties>" + "a".repeat(40 * 1024 * 1024),
      "word/document.xml": "<w:document><w:body/></w:document>",
    });
    const res = await docAnalysis.analyzeDocument("k", "docx");
    expect(res.status).toBe("NEEDS_REVIEW");
    expect(res.source).toBeNull();
    expect(res.pageCount).not.toBe(999);
  });
});

describe("unparseable formats", () => {
  it("legacy .doc always requires review", async () => {
    stored = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const res = await docAnalysis.analyzeDocument("k", "doc");
    expect(res.status).toBe("NEEDS_REVIEW");
    expect(res.pageCount).toBeNull();
  });

  it("unknown extensions fail rather than being guessed", async () => {
    stored = Buffer.from("x");
    const res = await docAnalysis.analyzeDocument("k", "txt");
    expect(res.status).toBe("FAILED");
  });
});

describe("PDF with an unreadable page tree", () => {
  it("never reports the raw-byte estimate as verified", async () => {
    // A PDF header whose page tree pdf-lib cannot load, but which contains
    // /Type /Page tokens. The estimate must come back as NEEDS_REVIEW.
    stored = Buffer.concat([
      Buffer.from("%PDF-1.4\n", "latin1"),
      Buffer.from("/Type /Page\n/Type /Page\n/Type /Page\n", "latin1"),
      Buffer.from("%%EOF\n", "latin1"),
    ]);
    const res = await docAnalysis.analyzeDocument("k", "pdf");
    // An estimate is only ever surfaced as an unverified review state.
    expect(res.status).toBe("NEEDS_REVIEW");
    expect(res.source).toBeNull();
    expect(res.pageCount).toBe(3);
    expect(res.error).toMatch(/confirm|estimate|could not/i);
  });
});
