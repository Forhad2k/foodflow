'use client';
import { ErrorState } from '@/components/states';
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return <main className="container py-20"><ErrorState error={null} onRetry={reset} /></main>;
}
