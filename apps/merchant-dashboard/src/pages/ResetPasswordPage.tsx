import { zodResolver } from '@hookform/resolvers/zod';
import { isApiError } from '@storeplix/api-client';
import { Button, Input } from '@storeplix/ui';
import { CheckCircle2, ChevronLeft } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useSearchParams } from 'react-router';
import { applyApiErrors } from '../auth/formErrors';
import { resetPasswordSchema, type ResetPasswordValues } from '../auth/schemas';
import { api } from '../lib/api';
import { AuthShell, FormAlert, FormTitle } from '../onboarding/AuthShell';

const BANGLA = 'পাসওয়ার্ড ভুলে গেছেন? এক মিনিটেই নতুন করে নিন।';

// Phase 2 §1.1: /reset-password?token=&email= from the reset email. No dedicated Figma frame — reuses
// L3 57:1198's AuthShell layout and copy. 422 invalid_reset_token → ask for a new link.
export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const email = params.get('email') ?? '';
  const [state, setState] = useState<'form' | 'done' | 'invalid'>(token && email ? 'form' : 'invalid');
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ResetPasswordValues>({ resolver: zodResolver(resetPasswordSchema), defaultValues: { password: '', password_confirmation: '' } });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await api.auth.resetPassword({ email, token, ...values });
      setState('done');
    } catch (error) {
      if (isApiError(error) && error.code === 'invalid_reset_token') setState('invalid');
      else setFormError(applyApiErrors(error, setError, ['password', 'password_confirmation']));
    }
  });

  return (
    <AuthShell
      pitch={{ eyebrow: 'Your shop, orders and money — in one place', headline: 'Locked out? Back in a minute.', bangla: BANGLA }}
      topLeft="Welcome back"
      topRight={
        <Link to="/login" className="text-body font-semibold text-brand-600 hover:text-brand-700">
          Sign in
        </Link>
      }
      mobile={{ variant: 'hero', title: 'Set a new password', bangla: BANGLA }}
    >
      <div className="flex flex-col gap-4 lg:gap-7">
        <Link to="/login" className="flex items-center gap-1.5 self-start text-body font-medium text-brand-600 hover:text-brand-700">
          <ChevronLeft aria-hidden className="size-4" /> Back to sign in
        </Link>
        {state === 'done' ? (
          <div role="status" className="flex flex-col gap-4">
            <CheckCircle2 aria-hidden className="size-10 text-success" />
            <FormTitle title="Your password has been reset" subtitle="Other devices were signed out. Sign in with your new password." />
            <Link to="/login" className="text-body font-semibold text-brand-600 hover:text-brand-700">
              Go to sign in
            </Link>
          </div>
        ) : state === 'invalid' ? (
          <div role="alert" className="flex flex-col gap-4">
            <FormTitle title="This reset link has expired" subtitle="Reset links work once and expire after 60 minutes. Request a new one." />
            <Link to="/forgot-password" className="text-body font-semibold text-brand-600 hover:text-brand-700">
              Request a new link
            </Link>
          </div>
        ) : (
          <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4 lg:gap-7">
            <FormTitle title="Set a new password" subtitle={`For ${email}. Choose a password you don’t use anywhere else.`} />
            {formError && <FormAlert>{formError}</FormAlert>}
            <div className="flex flex-col gap-3">
              <Input label="New password" type="password" autoComplete="new-password" hint="8+ characters · a letter · a number" error={errors.password?.message} {...register('password')} />
              <Input label="Confirm new password" type="password" autoComplete="new-password" error={errors.password_confirmation?.message} {...register('password_confirmation')} />
            </div>
            <Button type="submit" fullWidth loading={isSubmitting} className="min-h-12">
              Save new password
            </Button>
            <p className="text-center text-caption text-text-muted">For your safety, other devices will be signed out.</p>
          </form>
        )}
      </div>
    </AuthShell>
  );
}
