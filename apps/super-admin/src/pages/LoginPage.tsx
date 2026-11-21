import { zodResolver } from '@hookform/resolvers/zod';
import { SESSION_EXPIRED_MESSAGE } from '@storeplix/api-client';
import { Badge, Button, Input, Logo } from '@storeplix/ui';
import { ShieldCheck } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { useForm } from 'react-hook-form';
import { useAuth } from '../auth/AuthProvider';
import { applyApiErrors } from '../auth/formErrors';
import { loginSchema, type LoginValues } from '../auth/schemas';
import { session } from '../lib/session';

// Figma Platform Admin · "Platform / Sign in" 44:4707 — split screen: brand gradient panel
// (logo, "Platform admin", INTERNAL CONSOLE eyebrow, staff-only notice) + white form panel.
export function LoginPage() {
  const { login } = useAuth();
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const notice = useSyncExternalStore(session.subscribe, session.peekNotice, () => null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({ resolver: zodResolver(loginSchema), defaultValues: { email: '', password: '' } });

  const onSubmit = handleSubmit(async ({ email, password }) => {
    setFormError(null);
    try {
      await login({ email, password });
    } catch (error) {
      setFormError(applyApiErrors(error, setError, ['email', 'password']));
    }
  });

  return (
    <div className="flex min-h-dvh bg-surface-card">
      <aside className="hidden w-1/2 flex-col justify-between bg-linear-to-br from-brand-500 to-brand-700 p-12 text-text-inverse lg:flex">
        <div className="flex flex-col gap-1">
          <Logo tone="white" height={32} />
          <span className="text-caption opacity-80">Platform admin</span>
        </div>
        <div className="flex flex-col gap-4">
          <p className="text-caption font-medium tracking-[0.72px] uppercase opacity-80">Internal console</p>
          <h1 className="max-w-md text-display">Run every Store Plix shop from one place.</h1>
        </div>
        <p className="flex items-center gap-2 rounded-md bg-white/10 px-4 py-3 text-body">
          <ShieldCheck className="size-5 shrink-0" aria-hidden /> Staff access only. Every action is recorded in the audit log.
        </p>
      </aside>
      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="flex w-full max-w-[400px] flex-col gap-6">
          <div className="lg:hidden">
            <Logo height={28} />
          </div>
          <Badge tone="brand" className="self-start">
            Production
          </Badge>
          <h2 className="text-heading-24 text-text-primary">Sign in to Platform admin</h2>
          <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
            {notice === 'session_expired' && (
              <p role="status" className="rounded-md bg-info-bg px-3 py-2 text-body text-info">
                {SESSION_EXPIRED_MESSAGE}
              </p>
            )}
            {formError && (
              <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-body text-danger">
                {formError}
              </p>
            )}
            <Input label="Work email" type="email" autoComplete="username" error={errors.email?.message} {...register('email')} />
            <Input
              label="Password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              error={errors.password?.message}
              trailing={
                <button type="button" onClick={() => setShowPassword((s) => !s)} className="text-body font-medium text-brand-600">
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              }
              {...register('password')}
            />
            <Button type="submit" fullWidth loading={isSubmitting} className="mt-2">
              Continue
            </Button>
          </form>
          <p className="text-caption text-text-muted">Two-factor authentication will be required for all staff accounts.</p>
        </div>
      </main>
    </div>
  );
}
