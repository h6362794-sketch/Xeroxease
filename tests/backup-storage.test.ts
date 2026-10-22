import { createHash } from "crypto";
import { mkdtemp, readFile, rm, stat } from "fs/promises";
import http from "http";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { backupSupabaseStorage, resolveSafeObjectPath } from "../scripts/backup-storage";

interface MockBucketObject {
  key: string;
  bytes: Buffer;
  mimeType: string;
  reportedSize?: number;
}

function startMockStorageServer(expectedToken: string, objects: MockBucketObject[]) {
  const server = http.createServer(async (req, res) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${expectedToken}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "POST" && url.pathname === "/storage/v1/object/list/documents") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        prefix?: string;
        limit?: number;
        offset?: number;
      };
      const prefix = body.prefix ?? "";
      const limit = body.limit ?? 100;
      const offset = body.offset ?? 0;

      const entriesMap = new Map<string, unknown>();
      for (const obj of objects) {
        if (!obj.key.startsWith(prefix)) continue;
        const remainder = obj.key.slice(prefix.length);
        const slashIdx = remainder.indexOf("/");
        if (slashIdx >= 0) {
          const folderName = remainder.slice(0, slashIdx);
          if (!entriesMap.has(`dir:${folderName}`)) {
            entriesMap.set(`dir:${folderName}`, { name: folderName, id: null, metadata: null });
          }
        } else {
          entriesMap.set(`file:${remainder}`, {
            name: remainder,
            id: `obj-${remainder}`,
            updated_at: "2026-10-22T00:00:00.000Z",
            metadata: {
              size: obj.reportedSize ?? obj.bytes.byteLength,
              mimetype: obj.mimeType,
            },
          });
        }
      }
      if (prefix === "") {
        entriesMap.set("placeholder", {
          name: ".emptyFolderPlaceholder",
          id: "placeholder-id",
          metadata: { size: 0 },
        });
      }

      const all = Array.from(entriesMap.values());
      const page = all.slice(offset, offset + limit);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(page));
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/storage/v1/object/documents/")) {
      const encoded = url.pathname.slice("/storage/v1/object/documents/".length);
      const key = encoded
        .split("/")
        .map((s) => decodeURIComponent(s))
        .join("/");
      const found = objects.find((o) => o.key === key);
      if (!found) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      res.setHeader("Content-Type", found.mimeType);
      res.end(found.bytes);
      return;
    }

    res.statusCode = 404;
    res.end("Not found");
  });

  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Unexpected server address"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

describe("backupSupabaseStorage safety & integrity", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("recursively archives nested private objects outside the repo with verified SHA-256 digests and 0600 permissions", async () => {
    const secretRoleKey = "sb_secret_test_never_log_987654321";
    const fixtures: MockBucketObject[] = [
      {
        key: "usr_alpha/1760900001-aabbcc-thesis draft.pdf",
        bytes: Buffer.from("%PDF-1.7\nalpha-document-payload\n"),
        mimeType: "application/pdf",
      },
      {
        key: "usr_beta/1760900002-ddeeff-lab_notes.pdf",
        bytes: Buffer.from("%PDF-1.7\nbeta-document-payload-12345\n"),
        mimeType: "application/pdf",
      },
      {
        key: "payment-qr/shop-upi.png",
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        mimeType: "image/png",
      },
    ];

    const srv = await startMockStorageServer(secretRoleKey, fixtures);
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "xe-storage-bkp-"));
    tempDirs.push(outRoot);
    const targetDir = path.join(outRoot, "storage");

    try {
      const result = await backupSupabaseStorage({
        outDir: targetDir,
        supabaseUrl: srv.baseUrl,
        serviceRoleKey: secretRoleKey,
        bucket: "documents",
        allowInsecureLocalhost: true,
      });

      const expectedTotalBytes = fixtures.reduce((acc, f) => acc + f.bytes.byteLength, 0);
      expect(result.objectCount).toBe(3);
      expect(result.totalBytes).toBe(expectedTotalBytes);

      const manifestRaw = await readFile(result.manifestPath, "utf8");
      expect(manifestRaw).not.toContain(secretRoleKey);
      const manifest = JSON.parse(manifestRaw) as {
        objectCount: number;
        totalBytes: number;
        objects: Array<{ key: string; sizeBytes: number; sha256: string }>;
      };
      expect(manifest.objectCount).toBe(3);
      expect(manifest.totalBytes).toBe(expectedTotalBytes);

      for (const fixture of fixtures) {
        const savedPath = path.join(targetDir, "objects", ...fixture.key.split("/"));
        const savedBytes = await readFile(savedPath);
        expect(Buffer.compare(savedBytes, fixture.bytes)).toBe(0);
        const expectedSha = createHash("sha256").update(fixture.bytes).digest("hex");
        const entry = manifest.objects.find((o) => o.key === fixture.key);
        expect(entry?.sha256).toBe(expectedSha);

        if (process.platform !== "win32") {
          const st = await stat(savedPath);
          expect(st.mode & 0o777).toBe(0o600);
        }
      }
    } finally {
      await srv.close();
    }
  });

  it("refuses output directories inside the git repository working tree", async () => {
    const insideRepoPath = path.resolve(process.cwd(), "backups", "unsafe-in-repo-test");
    await expect(
      backupSupabaseStorage({
        outDir: insideRepoPath,
        supabaseUrl: "https://example.supabase.co",
        serviceRoleKey: "sb_secret_unused",
      })
    ).rejects.toThrow(/inside the git repository/i);
  });

  it("fails closed on truncated byte count mismatches without leaking credentials or object keys", async () => {
    const secretRoleKey = "sb_secret_do_not_expose_555";
    const srv = await startMockStorageServer(secretRoleKey, [
      {
        key: "student_secret_id/private-id-proof.pdf",
        bytes: Buffer.from("truncated"),
        reportedSize: 4096,
        mimeType: "application/pdf",
      },
    ]);
    const outRoot = await mkdtemp(path.join(os.tmpdir(), "xe-storage-trunc-"));
    tempDirs.push(outRoot);

    try {
      let caughtMessage = "";
      try {
        await backupSupabaseStorage({
          outDir: path.join(outRoot, "storage"),
          supabaseUrl: srv.baseUrl,
          serviceRoleKey: secretRoleKey,
          allowInsecureLocalhost: true,
        });
      } catch (err) {
        caughtMessage = err instanceof Error ? err.message : String(err);
      }
      expect(caughtMessage).toMatch(/byte-count mismatch/i);
      expect(caughtMessage).not.toContain(secretRoleKey);
      expect(caughtMessage).not.toContain("private-id-proof.pdf");
      expect(caughtMessage).not.toContain("student_secret_id");
    } finally {
      await srv.close();
    }
  });

  it("rejects path traversal keys before touching the filesystem", () => {
    const root = path.resolve(os.tmpdir(), "xe-safe-root");
    expect(() => resolveSafeObjectPath(root, "../outside.pdf")).toThrow();
    expect(() => resolveSafeObjectPath(root, "user/../../outside.pdf")).toThrow();
    expect(() => resolveSafeObjectPath(root, "user\\windows.pdf")).toThrow();
  });
});
