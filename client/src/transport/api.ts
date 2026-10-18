// Talks to the server through the same origin (/api is proxied by Vite in dev), so the
// HttpOnly session cookie is sent automatically.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

export async function api<T = void>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized();
    throw new ApiError(res.status, data.error ?? res.statusText);
  }
  return data as T;
}
