import { zodResolver } from '@hookform/resolvers/zod';
import { isApiError } from '@storeplix/api-client';
import type { StoreDomain } from '@storeplix/types';
import { Dialog, Input } from '@storeplix/ui';
import { Info } from 'lucide-react';
import { useId, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { connectDomainSchema, connectErrorMessage, looksLikeApex, stripHostname, type ConnectDomainInput, type ConnectDomainValues } from './domainCopy';
import { useAddDomain } from './queries';

// Connect dialog (PHASE-6-CONTRACT §8). V3 has no dialog frame; composed from Dialog (Overlay 128:221) + Input 3:58.
// Strips scheme/path client-side, apex hint without a PSL, inline copy for domain_invalid / _reserved / _taken / 402 / 429.

export function ConnectDomainDialog({ open, limitMax, onClose, onConnected }: { open: boolean; limitMax: number | null; onClose: () => void; onConnected: (d: StoreDomain) => void }) {
  const formId = useId();
  const add = useAddDomain();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors },
  } = useForm<ConnectDomainInput, unknown, ConnectDomainValues>({ resolver: zodResolver(connectDomainSchema), defaultValues: { hostname: '' } });
  const raw = useWatch({ control, name: 'hostname' }) ?? '';
  const host = stripHostname(raw);
  const apex = host.includes('.') && looksLikeApex(host);

  const close = () => {
    if (add.isPending) return;
    reset();
    setServerError(null);
    onClose();
  };

  const submit = handleSubmit(async ({ hostname }) => {
    setServerError(null);
    try {
      const domain = await add.mutateAsync(hostname);
      reset();
      onConnected(domain);
    } catch (e) {
      setServerError(isApiError(e) ? connectErrorMessage(e, limitMax) : 'We couldn’t connect this domain. Try again.');
    }
  });

  return (
    <Dialog
      open={open}
      size="md"
      title="Connect a domain"
      description="Use a domain you already own. You’ll add two DNS records where you bought it."
      confirmLabel="Connect"
      formId={formId}
      loading={add.isPending}
      onConfirm={() => undefined}
      onCancel={close}
    >
      <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-3">
        <Input
          label="Domain"
          placeholder="www.yourshop.com"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          inputMode="url"
          hint="Use a subdomain like www.yourshop.com."
          error={errors.hostname?.message ?? serverError ?? undefined}
          {...register('hostname', { onChange: () => setServerError(null) })}
        />
        {apex && (
          <p role="note" className="flex items-start gap-2 rounded-lg bg-info-bg px-3 py-2.5 text-[13px] leading-[18px] text-text-primary">
            <Info aria-hidden className="mt-px size-4 shrink-0 text-info" />
            <span>
              <strong className="font-semibold">{host}</strong> looks like your main domain. We recommend connecting <strong className="font-semibold">www.{host}</strong> as your shop address and adding {host} too. Your
              DNS provider must support CNAME flattening or ALIAS for {host}.
            </span>
          </p>
        )}
      </form>
    </Dialog>
  );
}
