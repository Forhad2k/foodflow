import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'FoodFlow · Dhaka Food Delivery', template: '%s · FoodFlow' },
  description: 'Order authentic Bengali food, biryani, and fast meals delivered fresh in Dhaka. Live GPS tracking from kitchen to door.',
  keywords: ['Food delivery Dhaka', 'Gulshan food delivery', 'Banani restaurants', 'FoodFlow Bangladesh'],
  openGraph: {
    title: 'FoodFlow · Dhaka Food Delivery',
    description: 'Hot food delivered from your favorite restaurants across Dhaka with live rider tracking.',
    locale: 'en_BD',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'FoodFlow · Dhaka Food Delivery',
    description: 'Order from verified restaurants near you in Dhaka with live tracking.',
  },
  robots: {
    index: true,
    follow: true,
  },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#10261C' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body suppressHydrationWarning><a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-control focus:bg-ink focus:px-4 focus:py-2 focus:text-ink-foreground">Skip to content</a><Providers>{children}</Providers></body>
    </html>
  );
}
