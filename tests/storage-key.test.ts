import { describe, it, expect, vi } from "vitest";

/**
 * Storage-key safety.
 *
 * The storage key used to be derived from a partially-sanitised filename, so a name
 * containing path components (or "..") could influence where the file landed.
 * `buildStorageKey` must always produce a key that stays inside the user's own
 * prefix and never contains a traversal segment.
 */

vi.mock("@/server/env", () => ({
  env: {
    get STORAGE_BACKEND() {
      return "local";
    },
    get STORAGE_BUCKET() {
      return "documents";
    },
    get LOCAL_STORAGE_DIR() {
      return ".data/uploads";
    },
    get SUPABASE_URL() {
      return "";
    },
    get SUPABASE_SERVICE_ROLE_KEY() {
      return "";
    },
  },
}));

let storage: typeof import("@/server/storage");

describe("sanitizeKeySegment", () => {
  it("strips directory components", async () => {
    storage = await import("@/server/storage");
    expect(storage.sanitizeKeySegment("../../etc/passwd")).toBe("passwd");
    expect(storage.sanitizeKeySegment("a/b\\c.pdf")).toBe("c.pdf");
  });

  it("removes control characters, separators and parent references", async () => {
    storage = await import("@/server/storage");
    expect(storage.sanitizeKeySegment("..")).toBe("file");
    expect(storage.sanitizeKeySegment("..\\..\\secret.docx")).toBe("secret.docx");
    expect(storage.sanitizeKeySegment("rep\x00ort.pdf")).toBe("report.pdf");
  });

  it("collapses repeated dots and never leaves a hidden-file prefix", async () => {
    storage = await import("@/server/storage");
    expect(storage.sanitizeKeySegment(".env")).not.toMatch(/^\./);
    expect(storage.sanitizeKeySegment("a...b.pdf")).toBe("a.b.pdf");
  });

  it("falls back to a safe placeholder for empty input", async () => {
    storage = await import("@/server/storage");
    expect(storage.sanitizeKeySegment("")).toBe("file");
    expect(storage.sanitizeKeySegment("///")).toBe("file");
  });
});

describe("buildStorageKey", () => {
  it("scopes the key under the owner and never escapes it", async () => {
    storage = await import("@/server/storage");
    for (const evil of [
      "../../../../etc/passwd",
      "/absolute/path/report.pdf",
      "..%2f..%2fsecret.pdf",
      "a/../../../root.pdf",
      "normal notes.pdf",
    ]) {
      const key = storage.buildStorageKey("user-1", evil);
      expect(key.startsWith("user-1/")).toBe(true);
      expect(key).not.toContain("..");
      expect(key).not.toContain("\\");
      expect(key.split("/").length).toBe(2);
    }
  });

  it("scopes keys even when the owner id itself is untrusted", async () => {
    storage = await import("@/server/storage");
    const key = storage.buildStorageKey("../../admin", "x.pdf");
    expect(key.startsWith("../../admin")).toBe(false);
    expect(key).not.toContain("..");
  });

  it("produces unique keys for identical filenames", async () => {
    storage = await import("@/server/storage");
    const a = storage.buildStorageKey("user-1", "notes.pdf");
    const b = storage.buildStorageKey("user-1", "notes.pdf");
    // Same owner/name but different random component -> no silent overwrite.
    expect(a).not.toBe(b);
  });
});
