import { zodResolver } from '@hookform/resolvers/zod';
import { isApiError } from '@storeplix/api-client';
import type { PlatformInvitation, PlatformRole } from '@storeplix/types';
import { Dialog, Input, cn } from '@storeplix/ui';
import { useMutation } from '@tanstack/react-query';
import { Clock, CreditCard, Eye, LifeBuoy, Mail, Shield, Users } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { LoggedAs } from '../components/LoggedAs';
import { errorMessage } from '../lib/errors';
import { api } from '../lib/api';
import { roleLabel } from '../lib/permissions';

export const roleCards: {
  role: PlatformRole;
  icon: ReactNode;
  text: string;
}[] = [
  {
    role: 'support',
    icon: <LifeBuoy />,
    text: 'View merchants, impersonate read-only, re-check domains',
  },
  {
    role: 'billing',
    icon: <CreditCard />,
    text: 'Change plans, extend, mark invoices paid, void and resend',
  },
  {
    role: 'read_only',
    icon: <Eye />,
    text: 'View merchants, billing, domains and the audit log. Can’t change anything',
  },
  {
    role: 'super_admin',
    icon: <Shield />,
    text: 'Everything, incl. suspensions and managing the team',
  },
];

const schema = z.object({
  email: z.email('Enter a valid work email'),
  role: z.enum(['super_admin', 'billing', 'support', 'read_only']),
});
type Values = z.infer<typeof schema>;

// Invite team member 45:9344 (P8-16): work email, role cards (four fixed roles; "Engineering" is not in 8.1), the
// "2-factor authentication is required" note and "Invite link expires in 7 days · single use".
export function InviteDialog({ onClose, onInvited }: { onClose: () => void; onInvited: (inv: PlatformInvitation) => void }) {
  const formId = useId();
  const { register, control, handleSubmit, setError, formState } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', role: 'support' },
  });
  const mutation = useMutation({
    mutationFn: (v: Values) => api.admin.team.invite({ email: v.email.trim(), role: v.role }),
    onSuccess: onInvited,
    onError: (e) => {
      if (isApiError(e) && e.fieldError('email')) setError('email', { type: 'server', message: e.fieldError('email') });
    },
  });
  const emailServerError = isApiError(mutation.error) && mutation.error.fieldError('email');

  return (
    <Dialog
      open
      title="Invite team member"
      description="They get platform admin access once they accept and set up 2FA."
      icon={<Users />}
      iconClassName="bg-brand-50 text-brand-600"
      size="lg"
      confirmLabel="Send invite"
      formId={formId}
      loading={mutation.isPending}
      footerStart={<LoggedAs />}
      onConfirm={() => undefined}
      onCancel={onClose}
    >
      <form id={formId} noValidate onSubmit={handleSubmit((v) => mutation.mutate(v))} className="flex flex-col gap-5">
        <Input
          label="Work email"
          type="email"
          autoComplete="off"
          leading={<Mail aria-hidden className="size-4" />}
          leadingDivider={false}
          hint="Use the teammate’s Storeplix work email."
          error={formState.errors.email?.message}
          {...register('email')}
        />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-body font-medium text-text-primary">Role</legend>
          <Controller
            control={control}
            name="role"
            render={({ field }) => (
              <div role="radiogroup" aria-label="Role" className="grid gap-3 sm:grid-cols-2">
                {roleCards.map((c) => {
                  const on = field.value === c.role;
                  return (
                    <button
                      key={c.role}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => field.onChange(c.role)}
                      className={cn(
                        'flex flex-col gap-2 rounded-lg border p-4 text-left outline-none focus-visible:shadow-focus',
                        on ? 'border-brand-600 bg-brand-50 shadow-[inset_0_0_0_1px_var(--color-brand-600)]' : 'border-border-default hover:bg-surface-subtle',
                      )}
                    >
                      <span className="flex items-center gap-2.5">
                        <span
                          aria-hidden
                          className="flex size-7 items-center justify-center rounded-md border border-border-default bg-surface-card text-text-secondary [&_svg]:size-4"
                        >
                          {c.icon}
                        </span>
                        <span className="flex-1 text-body font-semibold text-text-primary">{roleLabel[c.role]}</span>
                        <span aria-hidden className={cn('size-[18px] rounded-full border-2', on ? 'border-[5px] border-brand-600' : 'border-border-strong')} />
                      </span>
                      <span className="text-caption text-text-secondary">{c.text}</span>
                    </button>
                  );
                })}
              </div>
            )}
          />
        </fieldset>
        <div className="flex gap-3 rounded-lg bg-info-bg px-4 py-3">
          <Shield aria-hidden className="mt-0.5 size-4 shrink-0 text-info" />
          <span className="flex flex-col gap-0.5">
            <span className="text-body font-semibold text-info">2-factor authentication is required</span>
            <span className="text-caption text-text-secondary">They set up an authenticator app before their first sign-in.</span>
          </span>
        </div>
        <p className="flex items-center gap-3 text-body text-text-primary">
          <Clock aria-hidden className="size-4 text-text-muted" />
          <span className="flex-1">Invite link expires in 7 days · single use</span>
        </p>
        {mutation.isError && !emailServerError && (
          <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-body text-danger">
            {errorMessage(mutation.error)}
          </p>
        )}
      </form>
    </Dialog>
  );
}
