export class ApiError extends Error {
  status: number;
  code?: string;
  requestId?: string;
  retryAfter?: number;
  constructor(message: string, status: number, code?: string, requestId?: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryAfter = retryAfter;
  }
}

export async function api<T = unknown>(
  path: string,
  options?: RequestInit & { json?: unknown }
): Promise<T> {
  const { json, headers, ...rest } = options ?? {};
  const res = await fetch(path, {
    ...rest,
    headers: {
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(headers ?? {}),
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // no body
  }
  if (!res.ok) {
    const msg =
      (data as { error?: string })?.error ||
      `Request failed (${res.status})`;
    const code = (data as { code?: string })?.code;
    const requestId = (data as { requestId?: string })?.requestId || res.headers.get("x-request-id") || undefined;
    const retryAfterHeader = res.headers.get("retry-after");
    const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : undefined;
    throw new ApiError(msg, res.status, code, requestId, retryAfter);
  }
  return data as T;
}
