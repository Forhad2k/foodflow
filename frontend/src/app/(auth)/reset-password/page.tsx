'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { usePageTitle } from '@/hooks/use-page-title';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/form';
import { api, ApiError } from '@/lib/api';

const schema = z.object({
  token: z.string().min(20, 'Reset token must be at least 20 characters').max(200),
  password: z.string().min(10, 'Password must be at least 10 characters'),
  confirmPassword: z.string(),
}).refine((d) => d.password === d.confirmPassword, {
  message: 'Passwords do not match',
  path: ['confirmPassword'],
});
type Values = z.infer<typeof schema>;

function ResetPasswordForm() {
  usePageTitle('Set new password');
  const router = useRouter();
  const searchParams = useSearchParams();
  const tokenFromUrl = searchParams.get('token') ?? '';

  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { token: tokenFromUrl, password: '', confirmPassword: '' },
  });

  const submit = handleSubmit(async (v) => {
    setError(null);
    try {
      await api.resetPassword(v.token, v.password);
      setSuccess(true);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'INVALID_RESET_TOKEN') {
        setError('This reset link is invalid or has expired. Please request a new one.');
      } else {
        setError(e instanceof ApiError ? e.message : 'Could not reset password. Please try again.');
      }
    }
  });

  if (success) {
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-3xl font-extrabold">Password updated</h1>
          <p className="mt-1 text-muted-foreground">
            Your password has been changed successfully. All previous sessions have been signed out.
          </p>
        </div>
        <Button onClick={() => router.push('/login')} size="lg" className="w-full">
          Sign in with new password
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <div>
        <h1 className="text-3xl font-extrabold">Set a new password</h1>
        <p className="mt-1 text-muted-foreground">
          Must be at least 10 characters long.
        </p>
      </div>

      {error && (
        <p role="alert" className="rounded-control bg-destructive-soft px-4 py-3 text-sm font-semibold text-destructive">
          {error}
        </p>
      )}

      {!tokenFromUrl && (
        <Field id="token" label="Reset token" error={errors.token?.message}>
          <Input id="token" placeholder="Paste the token from your email" aria-invalid={!!errors.token} {...register('token')} />
        </Field>
      )}

      <Field id="password" label="New password" error={errors.password?.message}>
        <Input id="password" type="password" autoComplete="new-password" placeholder="At least 10 characters" aria-invalid={!!errors.password} {...register('password')} />
      </Field>

      <Field id="confirmPassword" label="Confirm new password" error={errors.confirmPassword?.message}>
        <Input id="confirmPassword" type="password" autoComplete="new-password" aria-invalid={!!errors.confirmPassword} {...register('confirmPassword')} />
      </Field>

      <Button type="submit" size="lg" className="w-full" loading={isSubmitting}>
        Update password
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        Back to{' '}
        <Link href="/login" className="font-semibold text-foreground underline underline-offset-4">
          Sign in
        </Link>
      </p>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  );
}

