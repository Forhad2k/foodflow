/**
 * Framework-free API client.
 *  • access token lives in memory only (never localStorage); the refresh token is an httpOnly cookie the browser manages
 *  • a 401 triggers ONE shared refresh (single-flight) and a single retry
 *  • errors surface as ApiError with the server's stable `code` (the UI switches on codes, never on message text)
 */
export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details?: unknown, public readonly requestId?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface SessionUser {
  id: string;
  email: string;
  role: 'CUSTOMER' | 'RESTAURANT_OWNER' | 'RIDER' | 'ADMIN';
  fullName: string;
}
export interface AuthResponse { user: SessionUser; accessToken: string; expiresIn: number }

type Query = Record<string, string | number | boolean | undefined | null | (string | number)[]>;
export interface RequestOptions { method?: string; body?: unknown; query?: Query; idempotencyKey?: string; signal?: AbortSignal; skipAuth?: boolean }

export class ApiClient {
  private token: string | null = null;
  private refreshing: Promise<AuthResponse | null> | null = null;
  /** Called whenever the session changes (login, refresh, logout, refresh failure). */
  onSession: (user: SessionUser | null) => void = () => undefined;

  constructor(private readonly baseUrl: string, private readonly fetchImpl: typeof fetch = (...a) => fetch(...a)) {}

  get accessToken() { return this.token; }
  setToken(t: string | null) { this.token = t; }

  url(path: string, query?: Query): string {
    const u = new URL(`${this.baseUrl.replace(/\/$/, '')}/api/v1${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null || v === '') continue;
      u.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    return u.toString();
  }

  async request<T>(path: string, opts: RequestOptions = {}, retried = false): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json', 'X-Requested-With': 'FoodFlow' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.token && !opts.skipAuth) headers.Authorization = `Bearer ${this.token}`;
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path, opts.query), {
        method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), headers, credentials: 'include', signal: opts.signal,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection and try again.');
    }

    if (res.status === 401 && !retried && !opts.skipAuth && !path.startsWith('/auth/')) {
      if (await this.refresh()) return this.request<T>(path, opts, true);
    }
    if (res.status === 204) return undefined as T;

    const text = await res.text();
    let data: unknown;
    try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
    if (!res.ok) {
      const e = (data as { error?: { code?: string; message?: string; details?: unknown; requestId?: string } } | undefined)?.error;
      throw new ApiError(res.status, e?.code ?? `HTTP_${res.status}`, e?.message ?? 'Something went wrong. Please try again.', e?.details, e?.requestId);
    }
    return data as T;
  }

  get<T>(path: string, query?: Query, signal?: AbortSignal) { return this.request<T>(path, { query, signal }); }
  post<T>(path: string, body?: unknown, o: Omit<RequestOptions, 'body' | 'method'> = {}) { return this.request<T>(path, { ...o, method: 'POST', body: body ?? {} }); }
  put<T>(path: string, body?: unknown) { return this.request<T>(path, { method: 'PUT', body: body ?? {} }); }
  patch<T>(path: string, body?: unknown) { return this.request<T>(path, { method: 'PATCH', body: body ?? {} }); }
  delete<T>(path: string) { return this.request<T>(path, { method: 'DELETE' }); }

  // ── session ──
  /** Exchanges the refresh cookie for a new access token. Concurrent callers share one request. */
  refresh(): Promise<AuthResponse | null> {
    this.refreshing ??= this.request<AuthResponse>('/auth/refresh', { method: 'POST', body: {}, skipAuth: true }, true)
      .then((r) => { this.token = r.accessToken; this.onSession(r.user); return r; })
      .catch(() => { this.token = null; this.onSession(null); return null; })
      .finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  private async establish(r: AuthResponse) { this.token = r.accessToken; this.onSession(r.user); return r; }
  async login(email: string, password: string) { return this.establish(await this.request<AuthResponse>('/auth/login', { method: 'POST', body: { email, password }, skipAuth: true })); }
  async register(input: { email: string; password: string; fullName: string; phone?: string; role: SessionUser['role'] }) {
    return this.establish(await this.request<AuthResponse>('/auth/register', { method: 'POST', body: input, skipAuth: true }));
  }
  async logout() {
    try { await this.request<void>('/auth/logout', { method: 'POST', body: {}, skipAuth: true }); } finally { this.token = null; this.onSession(null); }
  }
  async forgotPassword(email: string) {
    return this.request<{ message?: string }>('/auth/forgot-password', { method: 'POST', body: { email }, skipAuth: true });
  }
  async resetPassword(token: string, password: string) {
    return this.request<void>('/auth/reset-password', { method: 'POST', body: { token, password }, skipAuth: true });
  }
}

export const api = new ApiClient(process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000');
