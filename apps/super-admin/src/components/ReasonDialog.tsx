import { zodResolver } from '@hookform/resolvers/zod';
import { Dialog } from '@storeplix/ui';
import { useMutation } from '@tanstack/react-query';
import { useId, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { errorMessage } from '../lib/errors';
import { LoggedAs } from './LoggedAs';
import { ReasonField } from './ReasonField';
import { reasonSchema } from './reason';

const schema = z.object({ reason: reasonSchema });
type Values = z.infer<typeof schema>;

/**
 * Composed from the Suspend dialog 45:8866 pattern: title + description, reason textarea, "Logged as …" footer.
 * Used for every one-field admin write (reactivate, void, domain suspend/reinstate, staff disable/enable/reset 2FA,
 * revoke impersonation). Mount it only while open so each open starts clean.
 */
export function ReasonDialog<T>({
  title,
  description,
  confirmLabel,
  tone = 'primary',
  reasonLabel,
  reasonHint,
  children,
  onSubmit,
  onDone,
  onCancel,
}: {
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  /** Override the "Internal reason" label/hint when the reason is shown to the merchant (sender-ID revoke). */
  reasonLabel?: string;
  reasonHint?: string;
  children?: ReactNode;
  onSubmit: (reason: string) => Promise<T>;
  onDone: (result: T) => void;
  onCancel: () => void;
}) {
  const formId = useId();
  const { register, handleSubmit, formState } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { reason: '' },
  });
  const mutation = useMutation({
    mutationFn: (reason: string) => onSubmit(reason),
    onSuccess: onDone,
  });
  return (
    <Dialog
      open
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      tone={tone}
      formId={formId}
      loading={mutation.isPending}
      footerStart={<LoggedAs />}
      size="md"
      onConfirm={() => undefined}
      onCancel={onCancel}
    >
      <form id={formId} noValidate onSubmit={handleSubmit(({ reason }) => mutation.mutate(reason.trim()))} className="flex flex-col gap-4">
        {children}
        <ReasonField label={reasonLabel} hint={reasonHint} error={formState.errors.reason?.message} {...register('reason')} />
        {mutation.isError && (
          <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-body text-danger">
            {errorMessage(mutation.error)}
          </p>
        )}
      </form>
    </Dialog>
  );
}
