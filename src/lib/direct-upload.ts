/**
 * Browser side of the direct-to-private-storage upload protocol.
 *
 * The bytes go *here*: browser → storage host, never through a Next.js route. That is
 * the only way a 50 MB document can survive a function host's request-body cap. The
 * application's job is the part around it: authorize (intent), then verify (complete).
 *
 * Kept dependency-free on purpose (XHR rather than `fetch`): a PUT of a 50 MB blob
 * needs upload progress and a real abort, and `fetch` gives you neither without a
 * streams polyfill.
 */

export interface UploadIntent {
  fileId: string;
  /**
   * One-use completion credential. In memory only: never stored, never put in a URL,
   * never logged. Required to finish the upload, useless without the owner's session.
   */
  token: string;
  uploadUrl: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
  maxBytes: number;
  /**
   * Whether `POST /api/uploads` is a usable fallback for *this* deployment. It is
   * advisory only: a host with a small request-body cap cannot carry a 50 MB file,
   * which is why production refuses the proxy path for documents.
   */
  proxyUploadAvailable: boolean;
  fileSizeLimitNote: string | null;
}

export interface UploadCapability {
  enabled: boolean;
  maxBytes?: number;
  providerMaxBytes?: number;
  resumable?: boolean;
  proxyUploadAvailable?: boolean;
  code?: string;
  reason?: string;
}

export class DirectUploadError extends Error {
  code: string;
  status?: number;
  constructor(message: string, code = "DIRECT_UPLOAD_FAILED", status?: number) {
    super(message);
    this.name = "DirectUploadError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Client-side pre-flight. It cannot be trusted as enforcement — the server re-checks
 * the same limits at intent time and re-measures the stored object at completion — but
 * it saves a user from watching a 400 MB file fail at 99%.
 */
export function exceedsUploadLimit(sizeBytes: number, maxBytes: number): boolean {
  return !Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > maxBytes;
}

/**
 * Decide whether the wizard should use the direct path for this deployment.
 *
 * Anything unexpected falls back to the proxy route (the pre-existing behaviour), so a
 * capability probe that 404s or 500s can never leave the upload UI dead.
 */
export function chooseUploadMode(capability: UploadCapability | null | undefined): "direct" | "proxy" {
  return capability?.enabled === true ? "direct" : "proxy";
}

/**
 * Deployment-shape answers to the intent endpoint that mean "this host does not run the
 * direct protocol", not "your file is bad":
 *
 *  - 501 `BACKEND_UNSUPPORTED` — `STORAGE_BACKEND=local` cannot sign a storage URL.
 *  - 503 `DISABLED` / `SUPABASE_UNCONFIGURED` — the protocol is switched off.
 *
 * A capability probe can race a config change, or a deployment can roll out the flag and
 * the route in separate commits, so the wizard retries the *proxy* route once instead of
 * showing a dead drop zone. Every other status (401 session, 403, 409 quota, 413 size,
 * 4xx validation, 500) must propagate unchanged: falling back there would re-send bytes
 * that are doomed to fail again, and would hide the real reason.
 */
export function isUnsupportedDeployment(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (status !== 501 && status !== 503) return false;
  const code = (err as { code?: string } | null)?.code;
  return code === "DIRECT_UPLOAD_UNSUPPORTED" || code === "BACKEND_UNSUPPORTED" || code === "DISABLED" || code === "SUPABASE_UNCONFIGURED";
}

/** PUT to a signed storage URL. Only the raw body is sent: no auth header, no JSON. */
export function putToStorage(
  uploadUrl: string,
  body: Blob,
  opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl, true);
    // The signed URL already carries the one-purpose token in its query string, so no
    // Authorization header is needed — which also keeps this request CORS-simple (a
    // custom header would require a preflight and a provider-side allow-list).
    xhr.setRequestHeader("Content-Type", "text/plain;charset=UTF-8");
    xhr.upload.onprogress = (event) => {
      if (!opts.onProgress || !event.lengthComputable || event.total <= 0) return;
      opts.onProgress(Math.min(1, event.loaded / event.total));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      // 409 is the provider's "an object already exists here" answer, which a plain
      // retry of the same file will not fix — surface it as such.
      const conflict = xhr.status === 409;
      reject(
        new DirectUploadError(
          conflict
            ? "This file was already uploaded. Please refresh and continue."
            : `The storage service rejected the upload (${xhr.status}).`,
          conflict ? "ALREADY_UPLOADED" : "STORAGE_PUT_FAILED",
          xhr.status
        )
      );
    };
    xhr.onerror = () =>
      reject(
        new DirectUploadError(
          "Could not reach the storage service. Your file was not uploaded — check your connection and try again.",
          "STORAGE_UNREACHABLE"
        )
      );
    xhr.ontimeout = () => reject(new DirectUploadError("The upload timed out. Please try again.", "TIMEOUT"));
    if (opts.signal) {
      if (opts.signal.aborted) {
        xhr.abort();
        reject(new DirectUploadError("Upload cancelled.", "ABORTED"));
        return;
      }
      opts.signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.onabort = () => reject(new DirectUploadError("Upload cancelled.", "ABORTED"));
    xhr.send(body);
  });
}

/**
 * Full browser-side flow for one document: intent → PUT → complete.
 *
 * A completion failure is propagated with the server's message (the object is left for
 * the expiry sweep), and the intent is aborted best-effort so the user's file slot is
 * not held by a document that will never verify.
 */
export async function uploadDocumentDirect<TComplete = unknown>(
  file: File,
  deps: {
    requestIntent: (meta: { filename: string; mimeType: string; sizeBytes: number }) => Promise<UploadIntent>;
    reportComplete: (payload: { fileId: string; token: string }) => Promise<TComplete>;
    releaseIntent?: (fileId: string) => void | Promise<unknown>;
    onProgress?: (fraction: number) => void;
    signal?: AbortSignal;
  }
): Promise<{ fileId: string; complete: TComplete }> {
  const intent = await deps.requestIntent({
    filename: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
  });
  try {
    await putToStorage(intent.uploadUrl, file, { onProgress: deps.onProgress, signal: deps.signal });
    const complete = await deps.reportComplete({ fileId: intent.fileId, token: intent.token });
    return { fileId: intent.fileId, complete };
  } catch (err) {
    if (shouldReleaseIntentAfterFailure(err)) {
      // The bytes can never be accepted, so give the file slot back immediately
      // instead of parking a PENDING row until the intent expires.
      try {
        await deps.releaseIntent?.(intent.fileId);
      } catch {
        /* best effort — the expiry sweep is the backstop */
      }
    }
    throw err;
  }
}

/**
 * Release the intent only when completion proved the object is unusable. On a network
 * fault or a storage outage the bytes may well be fine, and the intent stays live so a
 * retry re-completes the *same* upload instead of re-sending 50 MB.
 */
export function shouldReleaseIntentAfterFailure(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "SIZE_MISMATCH" || code === "SIGNATURE_MISMATCH" || code === "TOKEN_MISMATCH" || code === "TOKEN_INVALID";
}
