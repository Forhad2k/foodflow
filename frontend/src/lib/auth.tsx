'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, SessionUser } from './api';

type Role = SessionUser['role'];
interface AuthState {
  status: 'loading' | 'anonymous' | 'authenticated';
  user: SessionUser | null;
  login: (email: string, password: string) => Promise<SessionUser>;
  register: (input: { email: string; password: string; fullName: string; phone?: string; role: Role }) => Promise<SessionUser>;
  logout: () => Promise<void>;
}
const Ctx = createContext<AuthState | null>(null);

/** Where each role lands. (Backend enforces permissions; this only picks the right workspace.) */
export const homeFor = (role: Role) => ({ CUSTOMER: '/', RESTAURANT_OWNER: '/owner', RIDER: '/rider', ADMIN: '/admin' })[role];

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  useEffect(() => {
    api.onSession = (u) => { setUser(u); if (!u) qc.clear(); };
    // Silent sign-in: the httpOnly refresh cookie (if any) is exchanged for an access token held in memory.
    void api.refresh().finally(() => setLoading(false));
  }, [qc]);

  const login = useCallback(async (e: string, p: string) => (await api.login(e, p)).user, []);
  const register = useCallback(async (i: Parameters<AuthState['register']>[0]) => (await api.register(i)).user, []);
  const logout = useCallback(async () => { await api.logout(); }, []);

  const value = useMemo<AuthState>(() => ({ status: loading ? 'loading' : user ? 'authenticated' : 'anonymous', user, login, register, logout }), [loading, user, login, register, logout]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}

/** Redirects to sign-in (remembering where you were) or to your own workspace if the role does not match. UX only. */
export function useRequireRole(...roles: Role[]) {
  const { status, user } = useAuth();
  const router = useRouter();
  const allowed = status === 'authenticated' && !!user && roles.includes(user.role);
  useEffect(() => {
    if (status === 'anonymous') router.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    else if (status === 'authenticated' && user && !roles.includes(user.role)) router.replace(homeFor(user.role));
  }, [status, user, router, roles.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ready: allowed, user };
}
