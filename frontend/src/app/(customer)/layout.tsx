import type { ReactNode } from 'react';
import { SiteHeader } from '@/components/site-header';
export default function CustomerLayout({ children }: { children: ReactNode }) {
  return (<><SiteHeader /><main id="main" className="container py-6 sm:py-8">{children}</main></>);
}
