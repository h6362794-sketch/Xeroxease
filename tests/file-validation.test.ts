import { describe, it, expect } from "vitest";
import {
  sanitizeFilename,
  hasDoubleExtension,
  getExtension,
  validateUpload,
} from "@/server/file-validation";

describe("sanitizeFilename", () => {
  it("strips path traversal", () => {
    expect(sanitizeFilename("../../etc/passwd.pdf")).toBe("passwd.pdf");
    expect(sanitizeFilename("C:\\Users\\evil\\doc.pdf")).toBe("doc.pdf");
  });
  it("removes control characters", () => {
    expect(sanitizeFilename("doc\x00\x1f.pdf")).toBe("doc.pdf");
  });
  it("replaces unsafe characters", () => {
    expect(sanitizeFilename("my <report>.pdf")).toBe("my _report_.pdf");
  });
  it("caps length", () => {
    const long = "a".repeat(200) + ".pdf";
    expect(sanitizeFilename(long).length).toBeLessThanOrEqual(85);
  });
  it("handles no extension", () => {
    expect(sanitizeFilename("document")).toBe("document");
  });
});

describe("getExtension", () => {
  it("extracts lowercase extension", () => {
    expect(getExtension("Report.PDF")).toBe("pdf");
  });
  it("returns empty when none", () => {
    expect(getExtension("file")).toBe("");
  });
});

describe("hasDoubleExtension", () => {
  it("detects malicious double extension", () => {
    expect(hasDoubleExtension("invoice.pdf.exe")).toBe(true);
    expect(hasDoubleExtension("doc.docx.js")).toBe(true);
  });
  it("allows safe single/dotted names", () => {
    expect(hasDoubleExtension("my.notes.pdf")).toBe(false);
    expect(hasDoubleExtension("report.pdf")).toBe(false);
  });
});

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const ZIP_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const EXE_MAGIC = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]);

describe("validateUpload", () => {
  it("accepts a valid PDF", () => {
    const r = validateUpload("notes.pdf", "application/pdf", 1024, PDF_MAGIC);
    expect(r.ok).toBe(true);
    expect(r.ext).toBe("pdf");
  });

  it("rejects disallowed extension", () => {
    const r = validateUpload("virus.exe", "application/octet-stream", 1024, EXE_MAGIC);
    expect(r.ok).toBe(false);
  });

  it("rejects MIME mismatch", () => {
    const r = validateUpload("doc.pdf", "text/html", 1024, PDF_MAGIC);
    expect(r.ok).toBe(false);
  });

  it("rejects spoofed magic bytes (exe renamed to .pdf)", () => {
    const r = validateUpload("trojan.pdf", "application/pdf", 1024, EXE_MAGIC);
    expect(r.ok).toBe(false);
  });

  it("accepts docx (zip container)", () => {
    const r = validateUpload("assign.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 2048, ZIP_MAGIC);
    expect(r.ok).toBe(true);
  });

  it("rejects empty file", () => {
    const r = validateUpload("empty.pdf", "application/pdf", 0, PDF_MAGIC);
    expect(r.ok).toBe(false);
  });

  it("rejects oversized file (>100MB)", () => {
    const r = validateUpload("huge.pdf", "application/pdf", 101 * 1024 * 1024, PDF_MAGIC);
    expect(r.ok).toBe(false);
  });

  it("accepts octet-stream declared MIME with correct magic", () => {
    const r = validateUpload("scan.pdf", "application/octet-stream", 1024, PDF_MAGIC);
    expect(r.ok).toBe(true);
  });
});
