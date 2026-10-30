import type { ReactNode } from 'react';
import { Logo } from '@/components/site-header';
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_1.1fr]">
      <aside className="hidden flex-col justify-between bg-ink p-10 text-ink-foreground lg:flex">
        <Logo className="text-ink-foreground" />
        <p className="max-w-md font-display text-4xl font-extrabold leading-tight">Every order starts as a ticket in a kitchen. Follow yours from the first stamp to your door.</p>
        <p className="text-sm text-ink-foreground/70">Restaurants, riders and customers across Dhaka.</p>
      </aside>
      <main id="main" className="flex items-center justify-center p-6"><div className="w-full max-w-md">{children}</div></main>
    </div>
  );
}
