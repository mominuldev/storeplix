import { zodResolver } from '@hookform/resolvers/zod';
import { isApiError } from '@storeplix/api-client';
import type { PlatformSecuritySettings } from '@storeplix/types';
import { Dialog, Input } from '@storeplix/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useAuth } from '../auth/AuthProvider';
import { LoggedAs } from '../components/LoggedAs';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { useToast } from '../lib/toast';
import { securityQueryKey } from './queryKeys';

const schema = z.object({
  current_password: z.string().min(1, 'Enter your current password'),
});
type Values = z.infer<typeof schema>;

/**
 * Amendment A1-4/A1-5: every change of `staff_two_factor_required` re-confirms the signed-in super admin's password.
 * 422 `invalid_password` lands on the password field. Turning it off outside `local` shows a warning (the API flags
 * the audit row `meta.risk: "high"`). Dialog pattern as Invite team member 45:9344 (icon tile, Logged as footer).
 */
export function ConfirmSecurityDialog({ enable, environment, onClose }: { enable: boolean; environment: string | null; onClose: () => void }) {
  const formId = useId();
  const queryClient = useQueryClient();
  const { setSecurity } = useAuth();
  const toast = useToast();
  const [showPassword, setShowPassword] = useState(false);
  const { register, handleSubmit, setError, formState } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { current_password: '' },
  });

  const mutation = useMutation({
    mutationFn: (v: Values) => api.admin.settings.updateSecurity({ staff_two_factor_required: enable, current_password: v.current_password }),
    onSuccess: (settings: PlatformSecuritySettings) => {
      queryClient.setQueryData(securityQueryKey, settings);
      setSecurity({ staff_two_factor_required: settings.staff_two_factor_required });
      toast(settings.staff_two_factor_required ? 'Two-step sign-in is on for platform staff.' : 'Two-step sign-in is off for platform staff.');
      onClose();
    },
    onError: (e) => {
      if (isApiError(e) && (e.code === 'invalid_password' || e.fieldError('current_password'))) {
        setError('current_password', {
          type: 'server',
          message: e.fieldError('current_password') ?? 'That password isn’t right. Try again.',
        });
      }
    },
  });
  const passwordServerError = isApiError(mutation.error) && (mutation.error.code === 'invalid_password' || !!mutation.error.fieldError('current_password'));
  const risky = !enable && environment !== 'local';

  return (
    <Dialog
      open
      title={enable ? 'Turn on two-step sign-in?' : 'Turn off two-step sign-in?'}
      description={
        enable
          ? 'Every platform staff member will need an authenticator app code at their next sign-in. Staff without one set it up then.'
          : 'Platform staff will sign in with their password only. Sessions already signed in are not affected.'
      }
      icon={enable ? <ShieldCheck /> : <ShieldAlert />}
      iconClassName={enable ? 'bg-brand-50 text-brand-600' : 'bg-danger-bg text-danger'}
      tone={enable ? 'primary' : 'danger'}
      confirmLabel={enable ? 'Turn on' : 'Turn off'}
      formId={formId}
      loading={mutation.isPending}
      footerStart={<LoggedAs />}
      onConfirm={() => undefined}
      onCancel={onClose}
    >
      <form id={formId} noValidate onSubmit={handleSubmit((v) => mutation.mutate(v))} className="flex flex-col gap-4">
        {risky && (
          <div role="alert" className="flex gap-3 rounded-lg bg-warning-bg px-4 py-3">
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
            <span className="flex flex-col gap-0.5">
              <span className="text-body font-semibold text-warning">This is the {environment ?? 'live'} environment</span>
              <span className="text-caption text-text-secondary">
                A stolen staff password would be enough to reach every shop’s data. Only turn this off for a short, planned reason. The change is
                recorded in the audit log as high risk.
              </span>
            </span>
          </div>
        )}
        <Input
          label="Your current password"
          type={showPassword ? 'text' : 'password'}
          autoComplete="current-password"
          autoFocus
          hint="We ask for it again before any security change."
          error={formState.errors.current_password?.message}
          trailing={
            <button type="button" onClick={() => setShowPassword((s) => !s)} className="text-body font-medium text-brand-600">
              {showPassword ? 'Hide' : 'Show'}
            </button>
          }
          {...register('current_password')}
        />
        {mutation.isError && !passwordServerError && (
          <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-body text-danger">
            {errorMessage(mutation.error)}
          </p>
        )}
      </form>
    </Dialog>
  );
}
