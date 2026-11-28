import type { SmsProvider, SmsProviderOverview, SmsProviderTestResult } from '@storeplix/types';
import { Button, Checkbox, cn, formatBdt, formatCount, Input, Modal } from '@storeplix/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, PlugZap, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { LoggedAs } from '../../components/LoggedAs';
import { api } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { errorCodeLabel, groupsLabel, nameMatches } from './format';
import { platformSmsKeys, smsErrorText } from './queries';
import { SummaryList } from './ui';

/** Typed-name input with the Figma 2114:10581 states: green border + tick when it matches. */
function TypeToConfirm({ name, value, onChange, tone = 'primary' }: { name: string; value: string; onChange: (v: string) => void; tone?: 'primary' | 'danger' }) {
  const ok = nameMatches(value, name);
  return (
    <Input
      label={`Type ${name} to confirm`}
      value={value}
      autoComplete="off"
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      fieldClassName={ok ? (tone === 'danger' ? 'border-danger' : 'border-success') : undefined}
      trailing={ok ? <Check aria-hidden className={tone === 'danger' ? 'text-danger' : 'text-success'} /> : undefined}
      hint={ok ? 'Name matches. This change is logged with your name.' : 'Not case-sensitive.'}
    />
  );
}

/**
 * Activate primary provider 2114:10581 (P89B-6/7): what changes, "Keep {old} as the failover" (hidden on first
 * activation), type-the-name input. 409 `sms_provider_test_required` / 422 `confirmation_mismatch` show inline.
 */
export function ActivatePrimaryDialog({
  provider,
  overview,
  onClose,
  onDone,
}: {
  provider: SmsProvider;
  overview: SmsProviderOverview | undefined;
  onClose: () => void;
  onDone?: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [typed, setTyped] = useState('');
  const [keep, setKeep] = useState(true);
  const old = overview?.primary && overview.primary.id !== provider.id ? overview.primary : null;
  const queued = (overview?.waiting ?? []).reduce((n, w) => n + w.queued, 0);
  const activate = useMutation({
    mutationFn: () => api.admin.platformSms.providers.activate(provider.id, { role: 'primary', confirm_name: typed.trim(), keep_previous_as_failover: old ? keep : undefined }),
    onSuccess: (next) => {
      qc.setQueryData(platformSmsKeys.overview, next);
      void qc.invalidateQueries({ queryKey: platformSmsKeys.root });
      toast(`${provider.name} is now the primary SMS provider`);
      onDone?.();
      onClose();
    },
  });

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      icon={<PlugZap />}
      iconClassName="bg-brand-50 text-brand-600"
      title={`Make ${provider.name} the primary provider?`}
      description={
        old
          ? `It replaces ${old.name} as the primary. Every platform SMS goes through ${provider.name} from now on.`
          : `Every platform SMS — and every shop SMS — goes through ${provider.name} instead of the server environment.`
      }
      footerStart={<LoggedAs />}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={activate.isPending}>
            Cancel
          </Button>
          <Button disabled={!nameMatches(typed, provider.name)} loading={activate.isPending} onClick={() => activate.mutate()}>
            Activate {provider.name}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <SummaryList
          title="What changes"
          rows={[
            { label: 'Sends', value: groupsLabel(provider.message_groups) },
            { label: 'Default sender', value: provider.default_sender_id },
            ...(queued > 0 ? [{ label: 'Queued SMS', value: `${formatCount(queued)} go out through ${provider.name} on their next try` }] : []),
            ...(old ? [{ label: old.name, value: keep ? 'Becomes the failover' : 'Becomes inactive', tone: 'muted' as const }] : []),
          ]}
        />
        {old && <Checkbox label={`Keep ${old.name} as the failover provider`} checked={keep} onChange={(e) => setKeep(e.target.checked)} />}
        <TypeToConfirm name={provider.name} value={typed} onChange={setTyped} />
        {activate.isError && (
          <p role="alert" className="text-caption font-medium text-danger">
            {smsErrorText(activate.error)}
          </p>
        )}
      </div>
    </Modal>
  );
}

/** Remove provider 2114:10634 (P89B-7): failover / draft / inactive only; type the name; credentials are deleted. */
export function RemoveProviderDialog({ provider, onClose, onDone }: { provider: SmsProvider; onClose: () => void; onDone?: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [typed, setTyped] = useState('');
  const remove = useMutation({
    mutationFn: () => api.admin.platformSms.providers.remove(provider.id, { confirm_name: typed.trim() }),
    onSuccess: (next) => {
      qc.setQueryData(platformSmsKeys.overview, next);
      void qc.invalidateQueries({ queryKey: platformSmsKeys.root });
      toast(`${provider.name} removed · its credentials were deleted`);
      onDone?.();
      onClose();
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      icon={<Trash2 />}
      iconClassName="bg-danger-bg text-danger"
      title={`Remove ${provider.name}?`}
      description={
        provider.role === 'failover'
          ? 'SMS stop failing over to it. Its credentials are deleted; its past SMS stay in the log.'
          : 'Its credentials are deleted; its past SMS stay in the log.'
      }
      footerStart={<LoggedAs />}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={remove.isPending}>
            Cancel
          </Button>
          <Button variant="danger" disabled={!nameMatches(typed, provider.name)} loading={remove.isPending} onClick={() => remove.mutate()}>
            Remove provider
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <TypeToConfirm name={provider.name} value={typed} onChange={setTyped} tone="danger" />
        {remove.isError && (
          <p role="alert" className="text-caption font-medium text-danger">
            {smsErrorText(remove.error)}
          </p>
        )}
      </div>
    </Modal>
  );
}

/** Test result card (2113:10237 success / 2113:10589 failed). The "Delivery report" line is hidden (Q267). */
export function ProviderTestResultCard({ result, providerName, onCheckCredentials, onRetry }: { result: SmsProviderTestResult; providerName: string; onCheckCredentials?: () => void; onRetry?: () => void }) {
  const passed = result.status === 'passed';
  const rows: [string, string][] = passed
    ? [
        ['Latency', result.latency_ms !== null ? `${(result.latency_ms / 1000).toFixed(1)} s` : '—'],
        ['Parts', String(result.parts)],
        ['Balance fetched', result.balance_paisa !== null ? formatBdt(result.balance_paisa) : 'Not reported'],
        ['Message ID', result.provider_message_id ?? '—'],
        ['Sent to', result.to_masked],
      ]
    : [];
  return (
    <div
      data-testid="provider-test-result"
      className={cn('flex flex-col gap-2 rounded-lg border px-4 py-3', passed ? 'border-success bg-success-bg' : 'border-danger bg-danger-bg')}
    >
      <p role={passed ? 'status' : 'alert'} className={cn('flex items-center gap-2 text-body font-semibold', passed ? 'text-text-primary' : 'text-danger')}>
        {passed ? <Check aria-hidden className="size-4 text-success" /> : null}
        {passed
          ? `Test sent — ${providerName} accepted it${result.latency_ms !== null ? ` in ${(result.latency_ms / 1000).toFixed(1)} s` : ''}`
          : `Test failed — ${result.error_code ? errorCodeLabel[result.error_code] : 'the provider refused it'}`}
      </p>
      {!passed && result.detail && <p className="text-caption break-words text-text-secondary">{result.detail}</p>}
      {rows.length > 0 && (
        <dl className="flex flex-col gap-1">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 text-body">
              <dt className="text-text-secondary">{k}</dt>
              <dd className="text-right font-medium break-all text-text-primary">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {!passed && (onCheckCredentials || onRetry) && (
        <div className="flex flex-wrap gap-2">
          {onCheckCredentials && (
            <Button size="sm" variant="secondary" onClick={onCheckCredentials}>
              Check credentials
            </Button>
          )}
          {onRetry && (
            <Button size="sm" variant="ghost" onClick={onRetry}>
              Try again
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** "409 sms_provider_test_required" etc. as one line; exported for the drawers. */
export function MutationError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-caption font-medium text-danger">
      {smsErrorText(error)}
    </p>
  );
}
