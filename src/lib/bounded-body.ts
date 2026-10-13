/**
 * Byte-capped request body streams.
 *
 * `Request.formData()` buffers the entire body before it resolves, so an upload
 * endpoint that checks size *after* parsing has already allocated the whole
 * payload. Checking `Content-Length` beforehand does not help either: it is a
 * client-supplied hint and can simply be omitted or falsified.
 *
 * These helpers wrap the body in a stream that counts bytes and errors out the
 * moment the cap is exceeded, so memory stays bounded and the socket is released
 * instead of draining a body we intend to discard.
 */

/** Raised when the body stream exceeds the hard byte cap. */
export class UploadTooLargeError extends Error {
  constructor(message = "upload exceeds the maximum size") {
    super(message);
    this.name = "UploadTooLargeError";
  }
}

/**
 * Wrap a body stream so it errors once more than `maxBytes` have been read.
 *
 * The chunk that crosses the cap is counted but not delivered, so a caller never
 * buffers more than `maxBytes + <one chunk>`.
 */
export function boundedBody(
  source: ReadableStream<Uint8Array>,
  maxBytes: number
): ReadableStream<Uint8Array> {
  let seen = 0;
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        seen += value.byteLength;
        if (seen > maxBytes) {
          controller.error(new UploadTooLargeError());
          // Release the socket instead of draining a body we intend to discard.
          await reader.cancel().catch(() => undefined);
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * Parse a multipart body through a byte-capped stream.
 *
 * Throws `UploadTooLargeError` if the body exceeds `maxBytes`, and whatever
 * `formData()` throws for a malformed body.
 */
export async function parseBoundedFormData(req: Request, maxBytes: number): Promise<FormData> {
  if (!req.body) return req.formData();
  const target = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: boundedBody(req.body, maxBytes),
    duplex: "half",
  } as RequestInit);
  return target.formData();
}

/**
 * Wrap a whole `Request` so its body is capped. Useful where the caller needs a
 * `Request` (rather than a parsed `FormData`) to pass on to a parser.
 */
export function boundedRequest(req: Request, maxBytes: number): Request {
  if (!req.body) return req;
  return new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: boundedBody(req.body, maxBytes),
    duplex: "half",
  } as RequestInit);
}
