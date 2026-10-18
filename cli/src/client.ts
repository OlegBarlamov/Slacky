// HTTP client for the Slacky API. Sign-in is name-only, so every run signs in again and
// keeps the session cookie in memory; nothing is written to disk.
import type { User } from '../../shared/types';

/** A failure the CLI reports on stderr and turns into an exit code. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly hint?: string,
  ) {
    super(message);
  }
}

export const EXIT = { usage: 1, notFound: 2, forbidden: 3, conflict: 4, unavailable: 5 } as const;

const exitCodeFor = (status: number) =>
  status === 404 ? EXIT.notFound : status === 401 || status === 403 ? EXIT.forbidden : status === 409 ? EXIT.conflict : status >= 500 ? EXIT.unavailable : EXIT.usage;

export class ApiError extends CliError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message, exitCodeFor(status));
  }
}

export class Client {
  private cookie: string | null = null;

  constructor(private readonly baseUrl: string) {}

  async register(name: string): Promise<User> {
    return this.signIn('register', name);
  }

  async login(name: string): Promise<User> {
    try {
      return await this.signIn('login', name);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) throw new CliError(e.message, EXIT.notFound, `run: slacky register ${name}`);
      throw e;
    }
  }

  async request<T = void>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetch(method, path, body);
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText);
    return data as T;
  }

  private async signIn(mode: 'register' | 'login', name: string): Promise<User> {
    const res = await this.fetch('POST', `/auth/${mode}`, { name });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText);
    const sid = res.headers.getSetCookie().find((c) => c.startsWith('sid='));
    if (!sid) throw new CliError('The server did not start a session', EXIT.unavailable);
    this.cookie = sid.split(';')[0];
    return data as User;
  }

  private async fetch(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { 'ngrok-skip-browser-warning': '1' };
    if (this.cookie) headers.Cookie = this.cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      return await fetch(`${this.baseUrl}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      const reason = ((e as Error).cause as Error | undefined)?.message ?? (e as Error).message;
      throw new CliError(`Can't reach ${this.baseUrl} (${reason})`, EXIT.unavailable, 'is the server running? set SLACKY_URL');
    }
  }
}
