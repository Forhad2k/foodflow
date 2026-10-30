import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/lib/api';

describe('Auth Flow client methods', () => {
  it('calls /auth/forgot-password with email payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      text: async () => JSON.stringify({ message: 'If that email exists, reset instructions were sent.' }),
    } as unknown as Response);

    const client = new ApiClient('http://localhost:4000', fetchMock);
    const res = await client.forgotPassword('customer@example.com');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/api/v1/auth/forgot-password',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'customer@example.com' }),
      }),
    );
    expect(res).toBeDefined();
  });

  it('calls /auth/reset-password with token and new password', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      text: async () => '',
    } as unknown as Response);

    const client = new ApiClient('http://localhost:4000', fetchMock);
    await client.resetPassword('sample-valid-token-32-chars-long', 'newSecurePassword123');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/api/v1/auth/reset-password',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ token: 'sample-valid-token-32-chars-long', password: 'newSecurePassword123' }),
      }),
    );
  });
});

