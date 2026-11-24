import { zodResolver } from '@hookform/resolvers/zod';
import { SESSION_EXPIRED_MESSAGE, isApiError } from '@storeplix/api-client';
import type { AdminLoginStep, AdminSession } from '@storeplix/types';
import { Badge, Button, Input } from '@storeplix/ui';
import { Shield } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { useForm } from 'react-hook-form';
import { AuthLayout, FormAlert } from '../auth/AuthLayout';
import { useAuth } from '../auth/AuthProvider';
import { EnrollStep } from '../auth/EnrollStep';
import { RecoveryCodesStep } from '../auth/RecoveryCodesStep';
import { loginSchema, type LoginValues } from '../auth/schemas';
import { TotpStep } from '../auth/TotpStep';
import { EXPIRED_TEXT, LOCKED_TEXT, LOCKED_TITLE } from '../auth/totpErrors';
import { api } from '../lib/api';
import { idleNotice, session } from '../lib/session';

type Step =
  | { kind: 'credentials' }
  | { kind: 'totp'; token: string; email: string }
  | { kind: 'enroll'; token: string; email: string }
  | { kind: 'codes'; email: string; session: AdminSession; codes: string[] };

type Banner = 'locked' | 'expired' | null;

// Figma Platform Admin · Sign in 44:4707 → 2FA 44:4784 (PHASE-8-1 §3.1): email + password → TOTP (or recovery code)
// or first-time enrolment → recovery codes → session. No "keep me signed in", security key or trusted device.
// Amendment A1-3: while staff two-step sign-in is switched off the password alone answers `step: "signed_in"` with
// the session — straight into the app, same as after the TOTP step.
export function LoginPage() {
  const { signIn } = useAuth();
  const [step, setStep] = useState<Step>({ kind: 'credentials' });
  const [banner, setBanner] = useState<Banner>(null);

  const exit = (reason: 'back' | 'locked' | 'expired') => {
    setBanner(reason === 'back' ? null : reason);
    setStep({ kind: 'credentials' });
  };

  return (
    <AuthLayout>
      {step.kind === 'credentials' && (
        <CredentialsStep
          banner={banner}
          onSignedIn={(s) => {
            setBanner(null);
            signIn(s);
          }}
          onStep={(s, email) => {
            setBanner(null);
            setStep(s.step === 'enroll' ? { kind: 'enroll', token: s.login_token, email } : { kind: 'totp', token: s.login_token, email });
          }}
        />
      )}
      {step.kind === 'totp' && <TotpStep loginToken={step.token} email={step.email} onSignedIn={signIn} onExit={exit} />}
      {step.kind === 'enroll' && (
        <EnrollStep
          loginToken={step.token}
          email={step.email}
          onExit={exit}
          onEnrolled={(s, codes) => setStep({ kind: 'codes', email: step.email, session: s, codes })}
        />
      )}
      {step.kind === 'codes' && <RecoveryCodesStep codes={step.codes} email={step.email} onDone={() => signIn(step.session)} />}
    </AuthLayout>
  );
}

function CredentialsStep({
  banner,
  onStep,
  onSignedIn,
}: {
  banner: Banner;
  onStep: (s: AdminLoginStep, email: string) => void;
  onSignedIn: (s: AdminSession) => void;
}) {
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const notice = useSyncExternalStore(session.subscribe, session.peekNotice, () => null);
  const idle = idleNotice.peek();
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
      const s = await api.admin.auth.login({ email, password });
      if (s.step === 'signed_in') {
        onSignedIn(s);
      } else {
        onStep(s, email);
      }
    } catch (error) {
      if (isApiError(error) && error.isValidation && error.fieldError('email')) {
        setError('email', {
          type: 'server',
          message: error.fieldError('email'),
        });
      } else if (isApiError(error) && error.status === 429) {
        setFormError(
          error.retryAfter ? `Too many sign-in attempts. Try again in ${error.retryAfter} s.` : 'Too many sign-in attempts. Wait a minute and try again.',
        );
      } else {
        setFormError(isApiError(error) ? error.message : 'Something went wrong. Please try again.');
      }
    }
  });

  return (
    <>
      <Badge tone="brand" className="h-5 self-start px-2 py-0.5">
        Production
      </Badge>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-heading-32 text-text-primary">Sign in to Platform admin</h1>
        <p className="text-body text-text-secondary">Use your @storeplix.com staff account. Merchant accounts can't sign in here.</p>
      </div>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
        <div className="flex flex-col gap-4">
          {banner === 'locked' && <FormAlert title={LOCKED_TITLE}>{LOCKED_TEXT}</FormAlert>}
          {banner === 'expired' && <FormAlert tone="info">{EXPIRED_TEXT}</FormAlert>}
          {!banner && idle && <FormAlert tone="info">You were signed out after 30 minutes without activity. Sign in again to continue.</FormAlert>}
          {!banner && !idle && notice === 'session_expired' && <FormAlert tone="info">{SESSION_EXPIRED_MESSAGE}</FormAlert>}
          {formError && <FormAlert>{formError}</FormAlert>}
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
        You may be asked for a 6-digit code after your password.
      </p>
    </>
  );
}
