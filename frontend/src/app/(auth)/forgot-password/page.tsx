'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { usePageTitle } from '@/hooks/use-page-title';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { api, ApiError } from '@/lib/api';

const schema = z.object({
  email: z.string().trim().email('Enter a valid email address'),
});
type Values = z.infer<typeof schema>;

export default function ForgotPasswordPage() {
  usePageTitle('Forgot password');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<Values>({
    resolver: zodResolver(schema),
  });

  const submit = handleSubmit(async (v) => {
    setError(null);
    try {
      await api.forgotPassword(v.email);
      setSubmitted(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
    }
  });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-3xl font-extrabold">Reset your password</h1>
        <p className="mt-1 text-muted-foreground">
          Enter the email address tied to your FoodFlow account.
        </p>
      </div>

      {submitted ? (
        <div className="rounded-card border border-border bg-panel p-6 space-y-4">
          <p className="font-semibold text-foreground">
            Check your inbox
          </p>
          <p className="text-sm text-muted-foreground">
            If an account exists for that email, we have sent instructions to reset your password. The link will be valid for 30 minutes.
          </p>
          <div className="pt-2">
            <Button asChild variant="outline" className="w-full">
              <Link href="/login">Back to sign in</Link>
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-5" noValidate>
          {error && (
            <p role="alert" className="rounded-control bg-destructive-soft px-4 py-3 text-sm font-semibold text-destructive">
              {error}
            </p>
          )}

          <Field id="email" label="Email address" error={errors.email?.message}>
            <Input id="email" type="email" autoComplete="email" placeholder="you@example.com" aria-invalid={!!errors.email} {...register('email')} />
          </Field>

          <Button type="submit" size="lg" className="w-full" loading={isSubmitting}>
            Send reset instructions
          </Button>

          <p className="text-center text-sm text-muted-foreground">
            Remembered your password?{' '}
            <Link href="/login" className="font-semibold text-foreground underline underline-offset-4">
              Sign in
            </Link>
          </p>
        </form>
      )}
    </div>
  );
}

