'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Toaster } from 'sonner';
import { ApiError } from '@/lib/api';
import { AuthProvider } from '@/lib/auth';
import { LocationProvider } from '@/lib/location';
import { I18nProvider } from '@/lib/i18n';

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 20_000, refetchOnWindowFocus: false,
        // Client errors (400-499) will not fix themselves: don't retry them.
        retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
      },
    },
  }));
  return (
    <QueryClientProvider client={client}>
      <AuthProvider>
        <LocationProvider>
          <I18nProvider>
            {children}
            <Toaster position="top-center" toastOptions={{ classNames: { toast: 'rounded-control border border-border font-sans' } }} />
          </I18nProvider>
        </LocationProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
