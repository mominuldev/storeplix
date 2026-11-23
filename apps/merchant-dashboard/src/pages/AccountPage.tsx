import { zodResolver } from '@hookform/resolvers/zod';
import { isApiError } from '@storeplix/api-client';
import type { TenantRole } from '@storeplix/types';
import { Avatar, Badge, Button, cn, EmptyState, Input, Modal, Select, Toggle } from '@storeplix/ui';
import { useMutation, useQueries } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router';
import { z } from 'zod';
import { useAuth } from '../auth/AuthProvider';
import { applyApiErrors } from '../auth/formErrors';
import { useImpersonation } from '../impersonation/hooks';
import { changePasswordSchema, type ChangePasswordValues } from '../auth/schemas';
import { PageHeader } from '../layout/PageHeader';
import { api } from '../lib/api';
import { roleLabel } from '../lib/permissions';
import { formatBdPhone, normalizeBdPhone } from '../lib/phone';
import { FormAlert } from '../onboarding/AuthShell';
import { fetchTenantStore, storeDomain, storeKey } from '../stores/useTenantStore';

const profileSchema = z.object({
  name: z.string().trim().min(2, 'Enter your full name').max(120),
  email: z.email('Enter a valid email address'),
  phone: z.string().trim().refine((v) => v === '' || normalizeBdPhone(v) !== null || /^\+[1-9]\d{7,14}$/.test(v), 'Enter a BD mobile or an international number'),
  current_password: z.string(),
});
type ProfileValues = z.infer<typeof profileSchema>;

function Card({ title, description, children, className, hideTitle = false }: { title: string; description?: string; children: React.ReactNode; className?: string; hideTitle?: boolean }) {
  return (
    <section aria-label={title} className={cn('flex flex-col gap-3 rounded-card border border-border-default bg-surface-card p-6 shadow-elevation-1', className)}>
      <div className={cn('flex flex-col gap-1', hideTitle && 'sr-only')}>
        <h2 className="text-body-lg font-medium text-text-primary">{title}</h2>
        {description && <p className="text-body text-text-secondary">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function daysAgo(iso: string | null | undefined): string {
  if (!iso) return 'Never changed';
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return d <= 0 ? 'Last changed today' : `Last changed ${d} ${d === 1 ? 'day' : 'days'} ago`;
}

const rolePill: Record<TenantRole, string> = { owner: 'bg-brand-50 text-brand-700', admin: 'bg-surface-subtle text-text-secondary', staff: 'bg-surface-subtle text-text-secondary' };

// Figma Account 148:33262: Profile 148:33851 (editable; photo, language & number style not in the API →
// disabled), Sign-in & security 148:33899 (password → modal; SMS two-step, authenticator, backup codes
// disabled), Your shops 148:33973, Transfer ownership 148:34025 (disabled). Sessions & My alerts hidden.
export function AccountPage() {
  const impersonation = useImpersonation();
  return impersonation ? <SupportSessionAccount shopName={impersonation.tenant_name} /> : <OwnAccount />;
}

/**
 * Contract §3.2/§7.2 (QA P8-QA-2): in a read-only support session `/auth/me` is the platform staff member, not the
 * shop's owner. Never present them as the owner or offer their personal profile, password or sign-out here — show the
 * Figma empty state (148:34032) instead. Leaving the session is the banner's "Exit impersonation".
 */
function SupportSessionAccount({ shopName }: { shopName: string }) {
  return (
    <>
      <PageHeader title="Your account" subtitle={`Read-only support session for ${shopName}.`} />
      <Card title="Account settings" hideTitle>
        <EmptyState
          icon={<ShieldCheck />}
          title="Account settings aren’t available in a support session."
          description="Profile, password and sign-in settings belong to each person on the shop. Nothing here can be viewed or changed while impersonating."
        />
      </Card>
    </>
  );
}

function OwnAccount() {
  const { user, tenants, activeTenant, logout, refreshUser, startSession } = useAuth();
  const [changing, setChanging] = useState(false);
  const [saved, setSaved] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const stores = useQueries({ queries: tenants.map((t) => ({ queryKey: storeKey(t.id), queryFn: () => fetchTenantStore(t.id), retry: false })) });

  const {
    register,
    handleSubmit,
    watch,
    setError,
    reset,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<ProfileValues>({
    resolver: zodResolver(profileSchema),
    values: { name: user?.name ?? '', email: user?.email ?? '', phone: user?.phone ? formatBdPhone(user.phone) : '', current_password: '' },
  });
  // eslint-disable-next-line react-hooks/incompatible-library -- watch() drives conditional UI only
  const emailChanged = watch('email').trim().toLowerCase() !== (user?.email ?? '').toLowerCase();

  const onSubmit = handleSubmit(async (v) => {
    setFormError(null);
    setSaved(false);
    if (emailChanged && !v.current_password) {
      setError('current_password', { message: 'Enter your current password to change your email' });
      return;
    }
    try {
      const phone = v.phone ? (normalizeBdPhone(v.phone) ?? v.phone) : null;
      await api.auth.updateProfile({
        name: v.name,
        ...(emailChanged ? { email: v.email, current_password: v.current_password } : {}),
        phone,
      });
      await refreshUser();
      reset();
      setSaved(true);
    } catch (e) {
      setFormError(applyApiErrors(e, setError, ['name', 'email', 'phone', 'current_password']));
    }
  });

  const verified = !!user?.phone_verified_at;
  const joined = activeTenant ? `${roleLabel[activeTenant.role]}${user?.created_at ? ` · joined ${new Date(user.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}` : '';

  return (
    <>
      <PageHeader
        title="Your account"
        subtitle={`${user?.name ?? ''}${activeTenant ? ` · ${roleLabel[activeTenant.role]} of ${activeTenant.name}` : ''} — only you see this page.`}
        actions={
          <Button variant="secondary" onClick={() => void logout()}>
            Sign out
          </Button>
        }
      />
      <div className="flex flex-col gap-6 xl:flex-row xl:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-6">
          {/* Figma 148:33851: no visible card title — the profile head opens the card. */}
          <Card title="Profile" hideTitle>
            <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
              <div className="flex items-center gap-4">
                <Avatar name={user?.name} size="lg" />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-heading text-text-primary">{user?.name}</span>
                  <span className="text-body text-text-secondary">{joined}</span>
                </div>
                <Button variant="secondary" size="sm" disabled title="Coming soon">
                  Change photo
                </Button>
              </div>
              {formError && <FormAlert>{formError}</FormAlert>}
              {saved && (
                <p role="status" className="rounded-md bg-success-bg px-3 py-2 text-body text-success">
                  Profile saved.
                </p>
              )}
              <div className="grid gap-x-3 gap-y-4 md:grid-cols-2">
                <Input label="Full name" autoComplete="name" error={errors.name?.message} {...register('name')} />
                <Input
                  label="Mobile number"
                  type="tel"
                  hint={user?.phone ? (verified ? 'Verified' : 'Not verified yet') : undefined}
                  trailing={
                    user?.phone && !verified ? (
                      <Link to="/verify-phone" className="text-caption font-semibold text-brand-600">
                        Verify
                      </Link>
                    ) : undefined
                  }
                  error={errors.phone?.message}
                  {...register('phone')}
                />
                <Input label="Email" type="email" autoComplete="email" error={errors.email?.message} {...register('email')} />
                {/* Figma field order: Email · Language / Number style · Time zone. */}
                {emailChanged && (
                  <Input label="Current password" type="password" autoComplete="current-password" hint="Needed to change your email" error={errors.current_password?.message} {...register('current_password')} />
                )}
                <Select label="Language" disabled hint="Coming soon">
                  <option>English</option>
                </Select>
                <Select label="Number style" disabled hint="Coming soon">
                  <option>English digits (1, 2, 3)</option>
                </Select>
                <Select label="Time zone" disabled hint="Coming soon">
                  <option>Asia/Dhaka (GMT+6)</option>
                </Select>
              </div>
              <div className="flex justify-end">
                <Button type="submit" loading={isSubmitting} disabled={!isDirty}>
                  Save profile
                </Button>
              </div>
            </form>
          </Card>

          <Card title="Sign-in & security" description="Keep your account safe. More sign-in options are on the way.">
            <ul>
              {[
                { title: 'Password', desc: daysAgo(user?.password_changed_at), action: <Button variant="secondary" size="sm" onClick={() => setChanging(true)}>Change</Button> },
                {
                  title: 'Two-step sign-in by SMS',
                  desc: 'Get a code on new devices',
                  action: (
                    <span className="flex items-center gap-2">
                      <Badge>Coming soon</Badge>
                      <Toggle checked={false} disabled label="Two-step sign-in by SMS" />
                    </span>
                  ),
                },
                { title: 'Authenticator app', desc: 'Google Authenticator, Authy — works without network', action: <Button variant="secondary" size="sm" disabled>Set up · soon</Button> },
                { title: 'Backup codes', desc: 'Use if you lose your phone', action: <Button variant="ghost" size="sm" disabled>View codes · soon</Button> },
              ].map((r) => (
                <li key={r.title} className="flex items-center gap-3 border-t border-border-default py-3.5">
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-body font-medium text-text-primary">{r.title}</span>
                    <span className="text-caption text-text-secondary">{r.desc}</span>
                  </span>
                  {r.action}
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <div className="flex w-full flex-col gap-6 xl:w-[360px]">
          <Card title="Your shops" className="gap-3">
            <ul className="flex flex-col gap-3">
              {tenants.map((t, i) => {
                const store = stores[i]?.data;
                return (
                  <li key={t.id} className="flex items-center gap-3 rounded-lg border border-border-default px-3 py-2.5">
                    <span className="flex size-8 items-center justify-center rounded-md bg-accent-100 text-body font-semibold text-accent-500">{(store?.name ?? t.name).charAt(0).toUpperCase()}</span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-body font-medium text-text-primary">{store?.name ?? t.name}</span>
                      <span className="truncate text-caption text-text-secondary">{store ? storeDomain(store) : 'No shop yet'}</span>
                    </span>
                    <span className={cn('rounded-full px-2 py-0.5 text-caption font-medium', rolePill[t.role])}>{roleLabel[t.role]}</span>
                  </li>
                );
              })}
            </ul>
          </Card>
          {activeTenant?.role === 'owner' && (
            <Card title="Transfer ownership" description="Hand the shop to another staff member. You’ll become a Manager." className="border-danger-bg">
              <Button variant="danger" size="sm" disabled className="self-start" title="Coming soon">
                Transfer shop… (coming soon)
              </Button>
            </Card>
          )}
        </div>
      </div>
      <ChangePasswordModal
        open={changing}
        onClose={() => setChanging(false)}
        onChanged={(auth) => startSession(auth, { keepTenant: true })}
      />
    </>
  );
}

function ChangePasswordModal({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: (auth: Awaited<ReturnType<typeof api.auth.changePassword>>) => void }) {
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<ChangePasswordValues>({ resolver: zodResolver(changePasswordSchema), defaultValues: { current_password: '', password: '', password_confirmation: '' } });
  const change = useMutation({
    mutationFn: (v: ChangePasswordValues) => api.auth.changePassword(v),
    onSuccess: (auth) => {
      // Session regenerated; all other sessions were logged out. Keep the active shop.
      onChanged(auth);
      reset();
      onClose();
    },
    onError: (e) => setFormError(isApiError(e) && e.isValidation ? applyApiErrors(e, setError, ['current_password', 'password', 'password_confirmation']) : (e as Error).message),
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Change password"
      description="You’ll stay signed in here; every other device is signed out."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="change-password" loading={change.isPending}>
            Change password
          </Button>
        </>
      }
    >
      <form id="change-password" noValidate onSubmit={handleSubmit((v) => change.mutate(v))} className="flex flex-col gap-3">
        {formError && <FormAlert>{formError}</FormAlert>}
        <Input label="Current password" type="password" autoComplete="current-password" error={errors.current_password?.message} {...register('current_password')} />
        <Input label="New password" type="password" autoComplete="new-password" hint="8+ characters · a letter · a number" error={errors.password?.message} {...register('password')} />
        <Input label="Confirm new password" type="password" autoComplete="new-password" error={errors.password_confirmation?.message} {...register('password_confirmation')} />
      </form>
    </Modal>
  );
}
