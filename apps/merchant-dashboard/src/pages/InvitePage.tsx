import { zodResolver } from '@hookform/resolvers/zod';
import { isApiError } from '@storeplix/api-client';
import { Button, EmptyState, Input, Spinner } from '@storeplix/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { MailX, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { applyApiErrors } from '../auth/formErrors';
import { acceptInviteSchema, type AcceptInviteInput, type AcceptInviteValues } from '../auth/schemas';
import { api } from '../lib/api';
import { roleLabel } from '../lib/permissions';
import { session } from '../lib/session';
import { AuthShell, FormAlert, FormTitle } from '../onboarding/AuthShell';
import { PhoneField } from '../otp/PhoneField';

const BANGLA = 'সব দোকান এক জায়গা থেকে চালান।';

function acceptErrorMessage(e: unknown): string {
  if (!isApiError(e)) return 'Something went wrong. Please try again.';
  switch (e.code) {
    case 'invitation_invalid':
      return 'This invitation has expired or was cancelled. Ask the shop owner to send a new one.';
    case 'invitation_email_mismatch':
      return 'This invitation was sent to a different email. Sign in with that account to accept it.';
    case 'plan_limit_reached':
      return 'This shop has no free staff seats right now. Ask the owner to free a seat or upgrade.';
    default:
      return e.message;
  }
}

/**
 * Phase 2 §1.3 `/invite?token=`: preview → new user: set name/phone/password and accept (201 AuthToken);
 * existing user: sign in (L1) then accept with Bearer (200 membership). Public route.
 */
export function InvitePage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const location = useLocation();
  const navigate = useNavigate();
  const { status, user, signInWithToken, setTenant, refreshUser, logout } = useAuth();
  const [formError, setFormError] = useState<string | null>(null);

  const preview = useQuery({ queryKey: ['invitation', token], queryFn: () => api.invitations.preview(token), enabled: !!token, retry: false });

  const join = useMutation({
    mutationFn: () => api.invitations.accept(token),
    onSuccess: async (membership) => {
      await refreshUser();
      setTenant(membership.id);
      navigate('/', { replace: true });
    },
    onError: async (e) => {
      if (isApiError(e) && e.code === 'already_member') navigate('/', { replace: true });
    },
  });

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<AcceptInviteInput, unknown, AcceptInviteValues>({
    resolver: zodResolver(acceptInviteSchema),
    defaultValues: { name: '', phone: '', password: '', password_confirmation: '' },
  });

  const createAccount = handleSubmit(async (values) => {
    setFormError(null);
    try {
      const auth = await api.invitations.accept(token, values);
      signInWithToken(auth);
      const tenantId = auth.user.tenants?.[0]?.id;
      if (tenantId) session.setTenantId(tenantId);
      navigate('/', { replace: true });
    } catch (e) {
      if (isApiError(e) && e.code === 'login_required') {
        navigate('/login', { state: { from: location.pathname + location.search } });
        return;
      }
      setFormError(isApiError(e) && e.isValidation ? applyApiErrors(e, setError, ['name', 'phone', 'password', 'password_confirmation']) : acceptErrorMessage(e));
    }
  });

  const shell = (children: React.ReactNode) => (
    <AuthShell
      pitch={{ eyebrow: 'Your shop, orders and money — in one place', headline: 'You’re invited to join a shop.', bangla: BANGLA }}
      topLeft="Staff invitation"
      topRight={null}
      mobile={{ variant: 'hero', title: 'Join the team', bangla: BANGLA }}
      showTrustRow={false}
    >
      {children}
    </AuthShell>
  );

  if (!token || preview.isError) {
    return shell(
      <EmptyState
        icon={<MailX />}
        title="This invitation isn’t valid anymore"
        description={preview.error ? acceptErrorMessage(preview.error) : 'The link is missing its token.'}
        action={
          <Link to="/login" className="text-body font-semibold text-brand-600">
            Go to sign in
          </Link>
        }
      />,
    );
  }
  if (preview.isPending) {
    return shell(
      <div className="flex justify-center py-10">
        <Spinner label="Loading invitation" />
      </div>,
    );
  }

  const inv = preview.data;
  const shopName = inv.store_name ?? inv.tenant_name;
  const header = (
    <div className="flex flex-col gap-3">
      <span className="flex size-14 items-center justify-center rounded-card bg-brand-50 text-brand-600">
        <UserPlus aria-hidden className="size-6" />
      </span>
      <FormTitle
        title={`Join ${shopName}`}
        subtitle={`${inv.invited_by_name} invited ${inv.email} as ${roleLabel[inv.role]}. The invitation expires ${new Date(inv.expires_at).toLocaleDateString()}.`}
      />
    </div>
  );

  if (inv.user_exists) {
    if (status !== 'authenticated') {
      return shell(
        <div className="flex flex-col gap-5 lg:gap-7">
          {header}
          <p className="text-body text-text-secondary">You already have a Storeplix account. Sign in as {inv.email} to accept.</p>
          <Button fullWidth className="min-h-12" onClick={() => navigate('/login', { state: { from: location.pathname + location.search } })}>
            Sign in to accept
          </Button>
        </div>,
      );
    }
    const wrongUser = user && user.email.toLowerCase() !== inv.email.toLowerCase();
    return shell(
      <div className="flex flex-col gap-5 lg:gap-7">
        {header}
        {wrongUser && <FormAlert>You’re signed in as {user.email}. This invitation is for {inv.email}.</FormAlert>}
        {join.isError && <FormAlert>{acceptErrorMessage(join.error)}</FormAlert>}
        <Button fullWidth className="min-h-12" loading={join.isPending} disabled={!!wrongUser} onClick={() => join.mutate()}>
          Join {shopName}
        </Button>
        {wrongUser && (
          <Button variant="secondary" fullWidth onClick={() => void logout()}>
            Sign out and switch account
          </Button>
        )}
      </div>,
    );
  }

  return shell(
    <form onSubmit={createAccount} noValidate className="flex flex-col gap-5 lg:gap-7">
      {header}
      {formError && <FormAlert>{formError}</FormAlert>}
      <div className="flex flex-col gap-3">
        <Input label="Email" value={inv.email} readOnly disabled />
        <Input label="Your name" autoComplete="name" error={errors.name?.message} {...register('name')} />
        <PhoneField error={errors.phone?.message} {...register('phone')} />
        <Input label="Password" type="password" autoComplete="new-password" hint="8+ characters · a letter · a number" error={errors.password?.message} {...register('password')} />
        <Input label="Confirm password" type="password" autoComplete="new-password" error={errors.password_confirmation?.message} {...register('password_confirmation')} />
      </div>
      <Button type="submit" fullWidth loading={isSubmitting} className="min-h-12">
        Create account & join
      </Button>
    </form>,
  );
}
