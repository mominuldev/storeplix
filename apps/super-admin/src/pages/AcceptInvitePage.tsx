import { zodResolver } from '@hookform/resolvers/zod';
import { isApiError } from '@storeplix/api-client';
import type { AdminSession, PlatformInvitationLookup } from '@storeplix/types';
import { Button, Input, Skeleton } from '@storeplix/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useNavigate } from 'react-router';
import { AuthLayout, FormAlert, ShieldTile } from '../auth/AuthLayout';
import { useAuth } from '../auth/AuthProvider';
import { EnrollStep } from '../auth/EnrollStep';
import { RecoveryCodesStep } from '../auth/RecoveryCodesStep';
import { acceptExistingSchema, acceptNewSchema, type AcceptExistingValues, type AcceptNewValues } from '../auth/schemas';
import { api } from '../lib/api';
import { roleLabel } from '../lib/permissions';

/** `#token=…` (P8-16: the token travels in the fragment, never in a server log). */
function tokenFromHash(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const t = params.get('token');
  return t && t.length > 0 ? t : null;
}

type Step = { kind: 'form' } | { kind: 'enroll'; loginToken: string } | { kind: 'codes'; session: AdminSession; codes: string[] };

// `/accept-invite` — composed from Invite 45:9344 + Sign in 44:4707 (§7.1): name + password (or the existing
// account's password), then the TOTP enrolment and recovery codes of the sign-in flow.
export function AcceptInvitePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { signIn } = useAuth();
  const [token] = useState(() => tokenFromHash(location.hash));
  const [step, setStep] = useState<Step>({ kind: 'form' });

  // Clear the fragment from the address bar and history as soon as it was read.
  useEffect(() => {
    if (location.hash) navigate({ pathname: location.pathname, search: location.search }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lookup = useQuery({
    queryKey: ['platform-invitation', token],
    queryFn: () => api.admin.invitations.lookup(token!),
    enabled: !!token,
    retry: false,
    staleTime: Infinity,
  });

  if (!token || lookup.isError) {
    return (
      <AuthLayout>
        <ShieldTile />
        <div className="flex flex-col gap-1.5">
          <h1 className="text-heading-32 text-text-primary">This invitation can’t be used</h1>
          <p className="text-body text-text-secondary">
            {lookup.isError && !(isApiError(lookup.error) && lookup.error.status === 404)
              ? 'We couldn’t check the invitation. Check your connection and open the link again.'
              : 'The link is invalid, already used or older than 7 days. Ask a super admin to send a new invitation.'}
          </p>
        </div>
        <Link to="/login" className="text-body font-medium text-brand-600">
          Go to sign in
        </Link>
      </AuthLayout>
    );
  }

  if (lookup.isPending) {
    return (
      <AuthLayout>
        <div role="status" aria-label="Checking your invitation" className="flex flex-col gap-3">
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-11 w-full" />
        </div>
      </AuthLayout>
    );
  }

  const invite = lookup.data;
  return (
    <AuthLayout>
      {step.kind === 'form' && <AcceptForm token={token} invite={invite} onEnroll={(loginToken) => setStep({ kind: 'enroll', loginToken })} />}
      {step.kind === 'enroll' && (
        <EnrollStep
          loginToken={step.loginToken}
          email={invite.email}
          onExit={() => navigate('/login', { replace: true })}
          onEnrolled={(s, codes) => setStep({ kind: 'codes', session: s, codes })}
        />
      )}
      {step.kind === 'codes' && (
        <RecoveryCodesStep
          codes={step.codes}
          email={invite.email}
          onDone={() => {
            signIn(step.session);
            navigate('/', { replace: true });
          }}
        />
      )}
    </AuthLayout>
  );
}

function AcceptForm({ token, invite, onEnroll }: { token: string; invite: PlatformInvitationLookup; onEnroll: (loginToken: string) => void }) {
  return (
    <>
      <ShieldTile />
      <div className="flex flex-col gap-1.5">
        <h1 className="text-heading-32 text-text-primary">Join Platform admin</h1>
        <p className="text-body text-text-secondary">
          You’re invited as <strong className="font-semibold text-text-primary">{roleLabel[invite.role]}</strong> with{' '}
          <strong className="font-semibold text-text-primary">{invite.email}</strong>. You’ll set up 2-factor verification next.
        </p>
      </div>
      {invite.existing_user ? <ExistingUserForm token={token} onEnroll={onEnroll} /> : <NewUserForm token={token} onEnroll={onEnroll} />}
    </>
  );
}

function useAcceptError() {
  const [error, setErrorText] = useState<string | null>(null);
  const handle = (e: unknown, mapField: (field: string, message: string) => boolean) => {
    if (isApiError(e) && e.isValidation && e.details) {
      let mapped = false;
      for (const [field, messages] of Object.entries(e.details)) if (messages[0]) mapped = mapField(field, messages[0]) || mapped;
      if (mapped) return setErrorText(null);
    }
    if (isApiError(e) && e.status === 404) return setErrorText('This invitation expired or was already used. Ask for a new one.');
    setErrorText(isApiError(e) ? e.message : 'Something went wrong. Please try again.');
  };
  return { error, handle, clear: () => setErrorText(null) };
}

function NewUserForm({ token, onEnroll }: { token: string; onEnroll: (loginToken: string) => void }) {
  const err = useAcceptError();
  const { register, handleSubmit, setError, formState } = useForm<AcceptNewValues>({
    resolver: zodResolver(acceptNewSchema),
    defaultValues: { name: '', password: '', password_confirmation: '' },
  });
  const onSubmit = handleSubmit(async (values) => {
    err.clear();
    try {
      const step = await api.admin.invitations.accept(token, {
        name: values.name.trim(),
        password: values.password,
        password_confirmation: values.password_confirmation,
      });
      onEnroll(step.login_token);
    } catch (e) {
      err.handle(e, (field, message) => {
        if (field === 'name' || field === 'password' || field === 'password_confirmation') {
          setError(field, { type: 'server', message });
          return true;
        }
        return false;
      });
    }
  });
  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
      {err.error && <FormAlert>{err.error}</FormAlert>}
      <Input label="Full name" autoComplete="name" error={formState.errors.name?.message} {...register('name')} />
      <Input
        label="Password"
        type="password"
        autoComplete="new-password"
        hint="At least 8 characters"
        error={formState.errors.password?.message}
        {...register('password')}
      />
      <Input
        label="Confirm password"
        type="password"
        autoComplete="new-password"
        error={formState.errors.password_confirmation?.message}
        {...register('password_confirmation')}
      />
      <Button type="submit" fullWidth loading={formState.isSubmitting} className="mt-2 min-h-11">
        Continue to 2FA setup
      </Button>
    </form>
  );
}

function ExistingUserForm({ token, onEnroll }: { token: string; onEnroll: (loginToken: string) => void }) {
  const err = useAcceptError();
  const { register, handleSubmit, setError, formState } = useForm<AcceptExistingValues>({
    resolver: zodResolver(acceptExistingSchema),
    defaultValues: { password: '' },
  });
  const onSubmit = handleSubmit(async ({ password }) => {
    err.clear();
    try {
      const step = await api.admin.invitations.accept(token, { password });
      onEnroll(step.login_token);
    } catch (e) {
      err.handle(e, (field, message) => {
        if (field === 'password') {
          setError('password', { type: 'server', message });
          return true;
        }
        return false;
      });
    }
  });
  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
      <p className="text-body text-text-secondary">You already have a Store Plix account with this email. Confirm its password to add platform access.</p>
      {err.error && <FormAlert>{err.error}</FormAlert>}
      <Input label="Current password" type="password" autoComplete="current-password" error={formState.errors.password?.message} {...register('password')} />
      <Button type="submit" fullWidth loading={formState.isSubmitting} className="mt-2 min-h-11">
        Continue to 2FA setup
      </Button>
    </form>
  );
}
