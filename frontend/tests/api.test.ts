import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from '@/lib/api';
import { formatDistance, formatEta, formatMoney } from '@/lib/format';

const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const user = { id: 'u1', email: 'a@b.c', role: 'CUSTOMER' as const, fullName: 'A B' };

describe('ApiClient', () => {
  it('builds URLs under /api/v1, dropping empty query values and joining arrays', () => {
    const c = new ApiClient('http://api.test/');
    expect(c.url('/restaurants', { lat: 23.79, q: '', cuisine: ['a', 'b'], page: undefined })).toBe('http://api.test/api/v1/restaurants?lat=23.79&cuisine=a%2Cb');
  });

  it('sends the bearer token, the CSRF header and credentials; never puts the token anywhere else', async () => {
    const f = vi.fn().mockResolvedValue(json(200, { ok: 1 }));
    const c = new ApiClient('http://api.test', f);
    c.setToken('tok');
    await c.get('/users/me');
    const [, init] = f.mock.calls[0];
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok', 'X-Requested-With': 'FoodFlow' });
    expect(init.credentials).toBe('include');
    expect(f.mock.calls[0][0]).not.toContain('tok');
  });

  it('turns the server error envelope into an ApiError with its stable code', async () => {
    const c = new ApiClient('http://api.test', vi.fn().mockResolvedValue(json(409, { error: { code: 'CHECKOUT_BLOCKED', message: 'Blocked', details: { issues: [1] }, requestId: 'r1' } })));
    const err = await c.get('/x').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'CHECKOUT_BLOCKED', details: { issues: [1] }, requestId: 'r1' });
  });

  it('reports a dead network as NETWORK_ERROR, not a crash', async () => {
    const c = new ApiClient('http://api.test', vi.fn().mockRejectedValue(new TypeError('failed')));
    await expect(c.get('/x')).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
  });

  it('on 401 refreshes ONCE (even for parallel calls) and retries with the new token', async () => {
    let refreshes = 0;
    const f = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/auth/refresh')) { refreshes++; return json(200, { user, accessToken: 'new', expiresIn: 900 }); }
      return (init.headers as Record<string, string>).Authorization === 'Bearer new' ? json(200, { fine: true }) : json(401, { error: { code: 'UNAUTHORIZED', message: 'x' } });
    });
    const c = new ApiClient('http://api.test', f as unknown as typeof fetch);
    const sessions: unknown[] = [];
    c.onSession = (u) => sessions.push(u);
    c.setToken('expired');
    const results = await Promise.all([c.get('/a'), c.get('/b'), c.get('/c')]);
    expect(results).toEqual([{ fine: true }, { fine: true }, { fine: true }]);
    expect(refreshes).toBe(1);
    expect(sessions).toEqual([user]);
  });

  it('a failed refresh signs the session out and surfaces the original 401', async () => {
    const f = vi.fn(async (url: string) => (url.endsWith('/auth/refresh') ? json(401, { error: { code: 'UNAUTHORIZED', message: 'gone' } }) : json(401, { error: { code: 'UNAUTHORIZED', message: 'Session ended' } })));
    const c = new ApiClient('http://api.test', f as unknown as typeof fetch);
    const sessions: unknown[] = [];
    c.onSession = (u) => sessions.push(u);
    c.setToken('expired');
    await expect(c.get('/users/me')).rejects.toMatchObject({ status: 401 });
    expect(c.accessToken).toBeNull();
    expect(sessions).toEqual([null]);
  });

  it('never retries auth endpoints (no refresh loops) and handles 204', async () => {
    const f = vi.fn().mockResolvedValue(json(401, { error: { code: 'UNAUTHORIZED', message: 'Invalid email or password' } }));
    const c = new ApiClient('http://api.test', f);
    await expect(c.login('a@b.c', 'wrong')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(f).toHaveBeenCalledTimes(1);
    const c2 = new ApiClient('http://api.test', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(c2.delete('/cart')).resolves.toBeUndefined();
  });

  it('sends the Idempotency-Key header for order placement', async () => {
    const f = vi.fn().mockResolvedValue(json(201, { id: 'o1' }));
    await new ApiClient('http://api.test', f).post('/orders', { a: 1 }, { idempotencyKey: 'key-12345678' });
    expect(f.mock.calls[0][1].headers['Idempotency-Key']).toBe('key-12345678');
  });
});

describe('formatting', () => {
  it('formats taka from minor units', () => {
    expect(formatMoney(32000)).toBe('৳320');
    expect(formatMoney(32050)).toBe('৳320.50');
    expect(formatMoney(0)).toBe('৳0');
    expect(formatMoney(123456700)).toBe('৳1,234,567');
  });
  it('formats distances and ETA ranges', () => {
    expect(formatDistance(480)).toBe('480 m');
    expect(formatDistance(1530)).toBe('1.5 km');
    expect(formatEta({ min: 25, max: 35 })).toBe('25–35');
  });
});
