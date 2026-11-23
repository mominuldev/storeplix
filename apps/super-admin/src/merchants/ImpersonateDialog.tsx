import { zodResolver } from '@hookform/resolvers/zod';
import type { ImpersonationTicket } from '@storeplix/types';
import { Dialog, Input } from '@storeplix/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Clock, Eye, ExternalLink, Lock, ScrollText } from 'lucide-react';
import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { LoggedAs } from '../components/LoggedAs';
import { ReasonField } from '../components/ReasonField';
import { reasonSchema } from '../components/reason';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';

const schema = z.object({
  reason: reasonSchema,
  ticket_ref: z.string().trim().max(64, 'Keep the ticket reference under 64 characters'),
});
type Values = z.infer<typeof schema>;

/** Opens the merchant dashboard on the ticket URL (fragment) in a new tab, without an opener reference. */
export function openImpersonation(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

// Impersonate reason dialog — composed from the Suspend/Change-plan dialog pattern (45:8866, 45:4989; §7.1):
// reason textarea, optional ticket ref, "Read-only · 15 minutes · audited" note. P8-9: the 201 answers a 60-second
// single-use ticket URL; we open it in a new tab and keep a fallback link here in case the browser blocked the tab.
export function ImpersonateDialog({ tenant, onClose }: { tenant: { id: string; name: string }; onClose: () => void }) {
  const formId = useId();
  const queryClient = useQueryClient();
  const [ticket, setTicket] = useState<ImpersonationTicket | null>(null);
  const { register, handleSubmit, formState } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { reason: '', ticket_ref: '' },
  });
  const mutation = useMutation({
    mutationFn: (v: Values) =>
      api.admin.tenants.impersonate(tenant.id, {
        reason: v.reason.trim(),
        ticket_ref: v.ticket_ref.trim() || null,
      }),
    onSuccess: (t) => {
      setTicket(t);
      openImpersonation(t.url);
      void queryClient.invalidateQueries({
        queryKey: ['admin', 'impersonations'],
      });
    },
  });

  if (ticket) {
    return (
      <Dialog
        open
        title="Impersonation started"
        description={`The merchant dashboard for ${tenant.name} opened in a new tab.`}
        confirmLabel="Done"
        cancelLabel={null}
        onConfirm={onClose}
        onCancel={onClose}
      >
        <div className="flex flex-col gap-3 text-body text-text-secondary">
          <p>Nothing opened? Your browser may have blocked the tab. This link works once, within 60 seconds:</p>
          <a
            href={ticket.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 font-medium text-brand-600 hover:underline"
          >
            Open the merchant dashboard
            <ExternalLink aria-hidden className="size-4" />
          </a>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      title={`Impersonate ${tenant.name}`}
      description="See the merchant dashboard exactly as the owner does."
      icon={<Eye />}
      iconClassName="bg-brand-50 text-brand-600"
      size="md"
      confirmLabel="Start read-only session"
      formId={formId}
      loading={mutation.isPending}
      footerStart={<LoggedAs />}
      onConfirm={() => undefined}
      onCancel={onClose}
    >
      <form id={formId} noValidate onSubmit={handleSubmit((v) => mutation.mutate(v))} className="flex flex-col gap-4">
        <ul
          aria-label="Session rules"
          className="flex flex-wrap gap-x-4 gap-y-2 rounded-lg bg-surface-subtle px-4 py-3 text-caption font-medium text-text-secondary"
        >
          <li className="flex items-center gap-1.5">
            <Lock aria-hidden className="size-3.5" /> Read-only
          </li>
          <li className="flex items-center gap-1.5">
            <Clock aria-hidden className="size-3.5" /> 15 minutes
          </li>
          <li className="flex items-center gap-1.5">
            <ScrollText aria-hidden className="size-3.5" /> Audited on the shop’s activity log
          </li>
        </ul>
        <ReasonField
          label="Reason"
          hint="Saved to the audit log; the merchant sees “Store Plix support” in their activity log"
          error={formState.errors.reason?.message}
          {...register('reason')}
        />
        <Input label="Support ticket (optional)" placeholder="e.g. TK-4821" error={formState.errors.ticket_ref?.message} {...register('ticket_ref')} />
        {mutation.isError && (
          <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-body text-danger">
            {errorMessage(mutation.error)}
          </p>
        )}
      </form>
    </Dialog>
  );
}
