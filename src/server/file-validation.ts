// Upload security: extension, MIME and magic-byte validation, filename sanitization.

import { ALLOWED_UPLOAD_TYPES, MAX_FILE_SIZE } from "@/lib/constants";

export interface FileValidationResult {
  ok: boolean;
  error?: string;
  ext: string;
  mime: string;
}

const EXT_TO_MIME: Record<string, string[]> = {
  pdf: ["application/pdf"],
  doc: ["application/msword"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ppt: ["application/vnd.ms-powerpoint"],
  pptx: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
};

const EXT_TO_MAGIC: Record<string, (bytes: Uint8Array) => boolean> = {
  // PDF: %PDF-
  pdf: (b) => b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d,
  // OLE2 (doc, ppt): D0 CF 11 E0 A1 B1 1A E1
  doc: (b) => b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 && b[4] === 0xa1 && b[5] === 0xb1 && b[6] === 0x1a && b[7] === 0xe1,
  // ZIP (docx, pptx): PK\x03\x04
  docx: (b) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07),
  ppt: (b) => b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 && b[4] === 0xa1 && b[5] === 0xb1 && b[6] === 0x1a && b[7] === 0xe1,
  pptx: (b) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07),
};

/** Sanitize a filename: strip paths/control chars, collapse unsafe chars, prevent double extensions. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() || "file";
  const cleaned = base
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[^a-zA-Z0-9._ -]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  const parts = cleaned.split(".");
  const ext = parts.length > 1 ? parts.pop()!.toLowerCase() : "";
  const stem = parts.join(".").replace(/\.+/g, ".").slice(0, 80) || "file";
  return `${stem}${ext ? "." + ext : ""}`;
}

export function getExtension(name: string): string {
  const parts = name.toLowerCase().split(".");
  return parts.length > 1 ? parts[parts.length - 1] : "";
}

/** Reject double extensions like file.pdf.exe (any executable/script segment after the stem). */
export function hasDoubleExtension(name: string): boolean {
  const parts = name.toLowerCase().split(".");
  if (parts.length < 3) return false;
  // suspicious: any segment after the stem that is a known executable/script type
  const dangerous = new Set(["exe", "dll", "bat", "cmd", "sh", "js", "vbs", "ps1", "scr", "com", "pif", "jar", "msi"]);
  return parts.slice(1).some((p) => dangerous.has(p));
}

export function validateUpload(
  filename: string,
  declaredMime: string,
  sizeBytes: number,
  headerBytes: Uint8Array
): FileValidationResult {
  const safeName = sanitizeFilename(filename);
  const ext = getExtension(safeName);

  if (!ALLOWED_UPLOAD_TYPES.includes(ext as (typeof ALLOWED_UPLOAD_TYPES)[number])) {
    return { ok: false, error: `Unsupported file type: .${ext || "unknown"}`, ext, mime: declaredMime };
  }
  if (sizeBytes <= 0) return { ok: false, error: "Empty file", ext, mime: declaredMime };
  if (sizeBytes > MAX_FILE_SIZE) {
    return { ok: false, error: `File exceeds the ${Math.floor(MAX_FILE_SIZE / (1024 * 1024))} MB limit`, ext, mime: declaredMime };
  }
  const allowedMimes = EXT_TO_MIME[ext] || [];
  // Some OS/browser combos send generic octet-stream; require match only when a specific type is declared.
  if (declaredMime && declaredMime !== "application/octet-stream" && !allowedMimes.includes(declaredMime)) {
    return { ok: false, error: "File content does not match its extension (MIME mismatch)", ext, mime: declaredMime };
  }
  const magic = EXT_TO_MAGIC[ext];
  if (magic && !magic(headerBytes)) {
    return { ok: false, error: "File signature does not match a valid document", ext, mime: declaredMime };
  }
  return { ok: true, ext, mime: declaredMime || allowedMimes[0] || "application/octet-stream" };
}
