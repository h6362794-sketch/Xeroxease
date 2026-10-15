// Single seam between the download/verification code and the storage adapter.
//
// One module to mock in tests (instead of stubbing two or three named exports of
// `src/server/storage.ts` from every test file), and one place where a future
// provider change lands. It adds no policy of its own.

import {
  StorageError,
  createSignedDownloadUrl as storageCreateSignedDownloadUrl,
  createSignedUploadTarget as storageCreateSignedUploadTarget,
} from "@/server/storage";

export async function createSignedUploadTarget(
  storageKey: string,
  opts: { expiresInSec: number }
) {
  try {
    return await storageCreateSignedUploadTarget(storageKey, opts);
  } catch (err) {
    if (err instanceof StorageError) throw err;
    // Never forward a provider error body: it can echo request details.
    throw new StorageError("Storage did not return an upload authorization. Please try again.");
  }
}

export async function createSignedDownloadUrl(
  storageKey: string,
  opts: { expiresInSec: number; download?: string }
) {
  try {
    return await storageCreateSignedDownloadUrl(storageKey, opts);
  } catch (err) {
    if (err instanceof StorageError) throw err;
    throw new StorageError("Storage did not return a download authorization. Please try again.");
  }
}
