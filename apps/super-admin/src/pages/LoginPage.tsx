import { zodResolver } from '@hookform/resolvers/zod';
import { SESSION_EXPIRED_MESSAGE } from '@storeplix/api-client';
import { Badge, Button, Input, Logo } from '@storeplix/ui';
import { Shield } from 'lucide-react';
import { useState, useSyncExternalStore, type CSSProperties } from 'react';
import { useForm } from 'react-hook-form';
import { useAuth } from '../auth/AuthProvider';
import { applyApiErrors } from '../auth/formErrors';
import { loginSchema, type LoginValues } from '../auth/schemas';
import { useHealth } from '../lib/health';
import { session } from '../lib/session';

// Brand panel 44:4708 fill: coral radial glow (top-left, 28%) + white→navy sheen (131.6°) over brand-600.
// The navy stop (#1f1473 @ 35%) has no token; brand-700 mixed into text-primary is the closest token blend.
const brandPanel: CSSProperties = {
  backgroundImage: [
    'radial-gradient(250px 375px at 125px 37.5px, color-mix(in srgb, var(--color-accent-500) 28%, transparent), transparent)',
    'linear-gradient(131.6deg, color-mix(in srgb, var(--color-text-inverse) 16%, transparent) 14.3%, transparent 53.6%, color-mix(in srgb, color-mix(in srgb, var(--color-brand-700) 45%, var(--color-text-primary)) 35%, transparent) 85.7%)',
  ].join(', '),
};

// Figma Platform Admin · "Platform / Sign in" 44:4707 — 600px brand panel (px 64 py 56, space-between: wordmark,
// pitch, security note) + white form side (400px form centred, gap 24; footer 48px from the bottom).
export function LoginPage() {
  const { login } = useAuth();
  const health = useHealth();
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const notice = useSyncExternalStore(session.subscribe, session.peekNotice, () => null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

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
      <aside
        style={brandPanel}
        className="sticky top-0 hidden h-dvh min-h-[720px] w-[600px] shrink-0 flex-col justify-between overflow-hidden bg-brand-600 px-16 py-14 text-text-inverse lg:flex"
      >
        <div className="flex flex-col gap-1.5">
          <Logo tone="inverse" height={28} />
          <span className="text-caption font-medium opacity-72">Platform admin</span>
        </div>
        <div className="flex flex-col gap-5">
          <p className="text-caption font-medium tracking-[0.96px] uppercase opacity-70">Internal console</p>
          <h1 className="text-display">Keep every Bangladeshi shop selling, every hour of the day.</h1>
          <p className="text-body-lg opacity-80">Billing, risk, integrations and support for every Storeplix merchant, in one place.</p>
        </div>
        <div className="flex items-center gap-3.5 rounded-[14px] border border-white/16 bg-text-primary/22 px-[18px] py-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-white/14">
            <Shield className="size-5" aria-hidden />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-body font-semibold">Staff access only · every action is audited</span>
            <span className="text-caption opacity-75">
              Sign-ins, impersonation and billing changes are logged with your name, IP and reason.
            </span>
          </span>
        </div>
      </aside>
      <main className="relative flex min-w-0 flex-1 flex-col items-center justify-center px-4 pt-10 pb-24 lg:px-20">
        <div className="flex w-full max-w-[400px] flex-col gap-6">
          <div className="lg:hidden">
            <Logo height={28} />
          </div>
          <Badge tone="brand" className="h-5 self-start px-2 py-0.5">
            Production
          </Badge>
          <div className="flex flex-col gap-1.5">
            <h2 className="text-heading-32 text-text-primary">Sign in to Platform admin</h2>
            <p className="text-body text-text-secondary">Use your @storeplix.com staff account. Merchant accounts can't sign in here.</p>
          </div>
          <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
            <div className="flex flex-col gap-4">
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
            </div>
            <Button type="submit" fullWidth loading={isSubmitting} className="min-h-11">
              Continue
            </Button>
          </form>
          <p className="flex items-center gap-2 text-caption text-text-muted">
            <Shield className="size-4 shrink-0" aria-hidden />
            2-factor verification will be required for every staff account.
          </p>
        </div>
        <p className="absolute bottom-8 left-4 flex flex-wrap items-center gap-1.5 text-caption text-text-muted lg:left-20">
          <span>Trouble signing in? Ask in #platform-oncall</span>
          {health.data && (
            <>
              <span aria-hidden>·</span>
              <span>v{health.data.version}</span>
            </>
          )}
        </p>
      </main>
    </div>
  );
}
