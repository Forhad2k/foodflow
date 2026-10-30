import Link from 'next/link';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
export default function NotFound() {
  return <main className="container py-20"><EmptyState title="We couldn't find that page" action={<Button asChild><Link href="/">Back to restaurants</Link></Button>}>The link may be old, or the restaurant may have closed its page.</EmptyState></main>;
}
