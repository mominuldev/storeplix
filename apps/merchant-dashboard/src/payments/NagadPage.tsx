import { isApiError } from '@storeplix/api-client';
import type { GatewayCapability, IntegrationMode, PaymentGatewayAccount } from '@storeplix/types';
import { Badge, Button, cn, Dialog, Input, SegmentedControl, Skeleton, Toggle } from '@storeplix/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, ChevronRight, Clock, Lock, ShieldCheck } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { dateTime } from '../catalog/format';
import { keys, useStoreScope } from '../catalog/scope';
import { ErrorBlock, StateCard } from '../catalog/states';
import { newIdempotencyKey } from '../commerce/format';
import { useReadOnly } from '../impersonation/hooks';
import { Banner, Columns, CopyRow, Panel, SettingRow, Tip } from '../integrations/components';
import { api } from '../lib/api';
import { toast } from '../online-store/components/Toast';
import { formatDate } from '../plan/billing';
import { GatewayLogo } from './GatewayLogo';
import { byProvider, gatewayMeta, integrationStatusMeta, isConnected, modeLabel } from './gateways';
import { capabilitiesOf, merchantIdMask, nagadErrorText, nagadInput, nagadProblems, type NagadField } from './nagad';
import { usePaymentGateways, usePaymentInvalidate } from './queries';

// PHASE-8-9D §9 (WEB) Nagad · Overview `/integrations/payments/nagad` (Figma 2134:67228, a copy of bKash 152:35101).
// Credentials: Sandbox / Live, Merchant ID (hint = last 4), merchant number, merchant private key and Nagad's public
// key — **write-only** PEM keys (masked, lock, "Replace", never Show/Copy; FIGMA part 2), callback URL to copy for the
// onboarding papers, verified banner. Checkout options from `capabilities` (P89D-45): Pre-authorise advance, Agreement
// checkout and Remember number greyed "Not offered by Nagad yet"; refunds "Refund in the Nagad portal" until certified.
// Rule 8: paid only after server-side verification (P89D-46). Not built (no API in 8.9d): the Payment methods /
// Transactions / Refunds / Settings tabs, This month, Settlement, Paid with, Recent payments, "Pass Nagad fee to shopper".

const PORTAL_URL = 'https://nagad.com.bd/';

function Breadcrumb() {
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-body font-medium">
      <Link to="/integrations" className="text-brand-600 hover:underline">
        Integrations
      </Link>
      <ChevronRight aria-hidden className="size-3.5 text-text-muted" />
      <Link to="/integrations?filter=payments" className="text-brand-600 hover:underline">
        Payments
      </Link>
      <ChevronRight aria-hidden className="size-3.5 text-text-muted" />
      <span aria-current="page" className="text-text-secondary">
        Nagad
      </span>
    </nav>
  );
}

export function NagadPage() {
  const scope = useStoreScope();
  const readOnly = useReadOnly();
  const gateways = usePaymentGateways();
  const [disconnecting, setDisconnecting] = useState(false);
  const [editing, setEditing] = useState(false);

  if (gateways.isPending) {
    return (
      <div className="flex flex-col gap-5" aria-busy="true" aria-label="Loading Nagad">
        <Breadcrumb />
        <Skeleton className="h-36 rounded-card" />
        <Skeleton className="h-96 rounded-card" />
      </div>
    );
  }
  if (gateways.isError) {
    return (
      <div className="flex flex-col gap-5">
        <Breadcrumb />
        <StateCard>
          <ErrorBlock title="We couldn’t load Nagad" error={gateways.error} onRetry={() => void gateways.refetch()} />
        </StateCard>
      </div>
    );
  }
  const account = byProvider(gateways.data).nagad;
  const manage = scope.canManageIntegrations && !readOnly;
  const connected = isConnected(account) || account?.status === 'error';
  const showForm = !connected || editing;

  return (
    <div className="flex flex-col gap-5">
      <Breadcrumb />
      <Header account={account} manage={manage} onDisconnect={connected && manage ? () => setDisconnecting(true) : undefined} />
      {!scope.canManageIntegrations && <p className="rounded-md bg-surface-subtle px-3 py-2 text-body text-text-secondary">Only owners and managers can connect or change payment accounts.</p>}
      <Columns
        left={
          <>
            {showForm ? (
              <CredentialsForm account={account} manage={manage} replacing={connected} onDone={() => setEditing(false)} />
            ) : (
              <CredentialsCard account={account!} manage={manage} onReplace={() => setEditing(true)} />
            )}
            <CheckoutOptions account={account} manage={manage} />
          </>
        }
        right={
          <>
            <Panel title="How Nagad payments are confirmed">
              <ul className="flex flex-col gap-2.5">
                {[
                  'The shopper pays on Nagad’s secure page with number, OTP and PIN',
                  'Nagad calls Storeplix back; we ask Nagad to verify the payment',
                  'The order is marked paid only when the amount, order and BDT match',
                  'No TrxID to check by hand',
                ].map((t) => (
                  <li key={t} className="flex items-start gap-2 text-body text-text-secondary">
                    <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-text-muted" /> {t}
                  </li>
                ))}
              </ul>
            </Panel>
            <Tip title="Onboarding papers">Nagad needs your trade licence, NID, bank details, a published refund policy and the callback URL above.</Tip>
          </>
        }
      />
      {disconnecting && account && <DisconnectDialog onClose={() => setDisconnecting(false)} />}
    </div>
  );
}

function Header({ account, manage, onDisconnect }: { account: PaymentGatewayAccount | undefined; manage: boolean; onDisconnect?: () => void }) {
  const st = integrationStatusMeta(account?.status ?? 'not_connected');
  const connected = isConnected(account);
  const { storeId } = useStoreScope();
  const [key, setKey] = useState(newIdempotencyKey);
  const test = useMutation({
    mutationFn: (_tab: Window | null) => api.paymentGateways.testPayment(storeId!, 'nagad', key),
    onSuccess: (res, tab) => {
      setKey(newIdempotencyKey());
      if (tab) {
        tab.opener = null;
        tab.location.href = res.redirect_url;
      }
      toast('Test payment opened in a new tab. This page updates when Nagad confirms it.');
    },
    onError: (e, tab) => {
      tab?.close();
      toast(nagadErrorText(e, 'We couldn’t start the test payment.'), 'error');
    },
  });
  const meta: { icon: ReactNode; text: string }[] = [];
  if (account?.connected_at) meta.push({ icon: <Check aria-hidden className="size-3.5 text-text-muted" />, text: `Connected ${formatDate(account.connected_at)}${account.connected_by ? ` by ${account.connected_by.name.split(' ')[0]}` : ''}` });
  if (account?.verified_at) meta.push({ icon: <Clock aria-hidden className="size-3.5 text-text-muted" />, text: `Last verified ${formatDate(account.verified_at)}` });
  meta.push({ icon: <ShieldCheck aria-hidden className="size-3.5 text-text-muted" />, text: 'Your own Nagad merchant account' });
  return (
    <section aria-label="Nagad" className="flex flex-col gap-4 rounded-card border border-border-default bg-surface-card px-4 py-[18px] shadow-elevation-1 lg:flex-row lg:items-center lg:gap-5 lg:px-6 lg:py-[22px]">
      <div className="flex min-w-0 flex-1 items-start gap-4 lg:items-center lg:gap-5">
        <GatewayLogo provider="nagad" size="lg" className="sm:size-16 sm:rounded-card" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-heading-24 font-semibold text-text-primary">Nagad</h1>
            <Badge tone={st.tone} dot={connected} size="sm">
              {st.label}
            </Badge>
            <Badge tone="neutral" size="sm">
              Payment gateway
            </Badge>
          </div>
          <p className="text-body text-text-secondary">Take Nagad payments for online and advance orders. Money goes straight to your own Nagad merchant account — confirmed automatically by Nagad’s callback, no TrxID to check.</p>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-text-secondary">
            {meta.map((m) => (
              <li key={m.text} className="flex items-center gap-1.5">
                {m.icon}
                {m.text}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="flex flex-col gap-2 lg:shrink-0 lg:items-end">
        <div className="flex flex-col gap-2 sm:flex-row">
          <a href={PORTAL_URL} target="_blank" rel="noreferrer noopener" className="inline-flex min-h-10 items-center justify-center rounded-control border border-border-default bg-surface-card px-4 text-body font-medium text-text-primary hover:bg-surface-subtle">
            Open Nagad merchant portal
          </a>
          {connected && manage && (
            <Button loading={test.isPending} onClick={() => test.mutate(window.open('', '_blank'))}>
              Test connection
            </Button>
          )}
        </div>
        {onDisconnect && (
          <button type="button" onClick={onDisconnect} className="self-start rounded-sm text-body font-medium text-danger outline-none hover:underline focus-visible:shadow-focus lg:self-end">
            Disconnect
          </button>
        )}
      </div>
    </section>
  );
}

function MaskedRow({ label, value, onReplace }: { label: string; value: string | null; onReplace?: () => void }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <span className="text-caption font-medium text-text-secondary">{label}</span>
      <div className="flex min-h-11 items-center gap-2 rounded-control border border-border-default bg-surface-canvas px-3 py-2.5">
        <Lock aria-hidden className="size-3.5 shrink-0 text-text-muted" />
        <span className="min-w-0 flex-1 truncate text-body text-text-primary">{value ?? '••••••••••••'}</span>
        {onReplace && (
          <button type="button" onClick={onReplace} aria-label={`Replace ${label}`} className="shrink-0 rounded-sm text-caption font-medium text-brand-600 outline-none hover:underline focus-visible:shadow-focus">
            Replace
          </button>
        )}
      </div>
      <p className="text-caption text-text-secondary">Write-only, never shown again</p>
    </div>
  );
}

/** Connected: masked, write-only credentials with Replace (opens the full form: Nagad keys are saved as a set). */
function CredentialsCard({ account, manage, onReplace }: { account: PaymentGatewayAccount; manage: boolean; onReplace: () => void }) {
  const replace = manage ? onReplace : undefined;
  return (
    <Panel
      title="Merchant credentials"
      description={gatewayMeta.nagad.portalHint}
      actions={
        account.mode ? (
          <Badge tone={account.mode === 'live' ? 'success' : 'warning'} size="sm">
            {account.mode === 'live' ? 'Live' : 'Sandbox'}
          </Badge>
        ) : undefined
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-caption font-medium text-text-secondary">Merchant ID</span>
          <div className="flex min-h-11 items-center rounded-control border border-border-default bg-surface-canvas px-3 py-2.5 text-body text-text-primary" aria-label={`Merchant ID ending ${(account.credentials_hint ?? '').slice(-4)}`}>
            {merchantIdMask(account.credentials_hint) ?? '—'}
          </div>
        </div>
        <MaskedRow label="Merchant private key" value={null} onReplace={replace} />
        {account.callback_url ? <CopyRow label="Callback URL" value={account.callback_url} /> : <div />}
        <MaskedRow label="Nagad public key" value={null} onReplace={replace} />
      </div>
      {account.status === 'error' ? (
        <Banner tone="danger">The last check with Nagad failed{account.last_error_code ? ` (${account.last_error_code.replace(/_/g, ' ')})` : ''}. Replace the keys or run Test connection again.</Banner>
      ) : account.verified_at ? (
        <Banner tone="success">
          {account.mode ? modeLabel[account.mode] : 'Connected'} · test payment and callback verified {dateTime(account.verified_at)}
        </Banner>
      ) : (
        <Banner tone="info">Keys saved. Run Test connection to make a {account.mode === 'live' ? '৳ 1' : '৳ 10 sandbox'} payment and confirm the callback.</Banner>
      )}
    </Panel>
  );
}

function KeyArea({ id, label, value, error, onChange, hint }: { id: string; label: string; value: string; error?: string; onChange: (v: string) => void; hint: string }) {
  return (
    <div className="flex flex-col gap-1.5 sm:col-span-2">
      <label htmlFor={id} className="text-caption font-medium text-text-secondary">
        {label}
      </label>
      <textarea
        id={id}
        rows={4}
        maxLength={8192}
        autoComplete="off"
        spellCheck={false}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-help`}
        onChange={(e) => onChange(e.target.value)}
        placeholder="-----BEGIN … KEY-----"
        className={cn('rounded-control border bg-surface-card px-3.5 py-2.5 font-mono text-caption text-text-primary outline-none [-webkit-text-security:disc] focus:border-brand-600', error ? 'border-danger' : 'border-border-default')}
      />
      <p id={`${id}-help`} className={cn('text-caption', error ? 'text-danger' : 'text-text-muted')}>
        {error ?? hint}
      </p>
    </div>
  );
}

function CredentialsForm({ account, manage, replacing, onDone }: { account: PaymentGatewayAccount | undefined; manage: boolean; replacing: boolean; onDone: () => void }) {
  const scope = useStoreScope();
  const qc = useQueryClient();
  const invalidate = usePaymentInvalidate();
  const [mode, setMode] = useState<IntegrationMode>(account?.mode ?? 'sandbox');
  const [values, setValues] = useState<Record<NagadField, string>>({ merchant_id: '', merchant_number: '', merchant_private_key: '', pg_public_key: '' });
  const [touched, setTouched] = useState(false);
  const [serverErrors, setServerErrors] = useState<Partial<Record<NagadField, string>>>({});
  const problems = touched ? nagadProblems(values) : {};
  const errors = { ...serverErrors, ...problems };
  const save = useMutation({
    mutationFn: () => api.paymentGateways.connect(scope.storeId!, 'nagad', { mode, credentials: nagadInput(values) }),
    onSuccess: async (saved) => {
      // Never keep keys in memory once the API has them.
      setValues({ merchant_id: '', merchant_number: '', merchant_private_key: '', pg_public_key: '' });
      setTouched(false);
      qc.setQueryData<PaymentGatewayAccount[]>(keys.paymentGateways(scope), (list) => (list ? [...list.filter((a) => a.provider !== 'nagad'), saved] : list));
      toast(replacing ? 'Nagad keys replaced. The old keys are deleted.' : 'Nagad connected. Your keys are saved and encrypted.');
      await invalidate.gateways();
      onDone();
    },
    onError: (e) => {
      const fe: Partial<Record<NagadField, string>> = {};
      if (isApiError(e)) for (const [k, m] of Object.entries(e.fieldErrors ?? {})) fe[k.replace(/^credentials\./, '') as NagadField] = m[0] ?? '';
      setServerErrors(fe);
    },
  });
  const set = (k: NagadField) => (v: string) => {
    setValues((s) => ({ ...s, [k]: v }));
    setServerErrors((s) => ({ ...s, [k]: undefined }));
  };
  if (!manage) {
    return (
      <Panel title="Merchant credentials" description={gatewayMeta.nagad.portalHint}>
        <p className="text-body text-text-secondary">Nagad isn’t connected. An owner or manager can connect it with the shop’s Nagad merchant keys.</p>
      </Panel>
    );
  }
  return (
    <Panel
      title={replacing ? 'Replace Nagad keys' : 'Connect Nagad'}
      description={gatewayMeta.nagad.portalHint}
      actions={
        <SegmentedControl
          aria-label="Mode"
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'sandbox', label: 'Sandbox' },
            { value: 'live', label: 'Live' },
          ]}
        />
      }
    >
      <form
        noValidate
        aria-label="Nagad credentials"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (Object.keys(nagadProblems(values)).length) return;
          save.mutate();
        }}
      >
        {replacing && <p className="text-caption text-text-secondary">Nagad keys are saved together: enter all four again. The current keys keep working until the new ones are saved.</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Input id="nagad-merchant_id" label="Merchant ID" autoComplete="off" spellCheck={false} maxLength={64} value={values.merchant_id} error={errors.merchant_id} onChange={(e) => set('merchant_id')(e.target.value)} />
          <Input id="nagad-merchant_number" label="Merchant number" inputMode="tel" autoComplete="off" maxLength={20} placeholder="01700000000" value={values.merchant_number} error={errors.merchant_number} onChange={(e) => set('merchant_number')(e.target.value)} />
          <KeyArea id="nagad-merchant_private_key" label="Merchant private key" value={values.merchant_private_key} error={errors.merchant_private_key} onChange={set('merchant_private_key')} hint="RSA, 2048 bits or more. Stored encrypted; never shown again." />
          <KeyArea id="nagad-pg_public_key" label="Nagad public key" value={values.pg_public_key} error={errors.pg_public_key} onChange={set('pg_public_key')} hint="The payment gateway public key Nagad gave you." />
        </div>
        <p className="flex items-center gap-2.5 rounded-control bg-surface-canvas px-3.5 py-2.5 text-caption text-text-secondary">
          <ShieldCheck aria-hidden className="size-4 shrink-0 text-brand-600" /> Encrypted and used only to start and verify payments for your shop. Money goes straight to your Nagad merchant account.
        </p>
        {mode === 'live' && <p className="text-caption text-warning">Live mode takes real money. Use your live keys from Nagad.</p>}
        {save.error ? (
          <p role="alert" className="rounded-control bg-danger-bg px-3.5 py-2.5 text-body text-danger">
            {nagadErrorText(save.error)}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2.5">
          <Button type="submit" loading={save.isPending}>
            {replacing ? 'Save new keys' : 'Save and connect'}
          </Button>
          {replacing && (
            <Button variant="secondary" onClick={onDone} disabled={save.isPending}>
              Cancel
            </Button>
          )}
        </div>
      </form>
    </Panel>
  );
}

const NOT_OFFERED = 'Not offered by Nagad yet';

function CheckoutOptions({ account, manage }: { account: PaymentGatewayAccount | undefined; manage: boolean }) {
  const scope = useStoreScope();
  const invalidate = usePaymentInvalidate();
  const caps = capabilitiesOf(account);
  const has = (c: GatewayCapability) => caps.includes(c);
  const connected = isConnected(account);
  const update = useMutation({
    mutationFn: (input: { enabled?: boolean; is_default?: boolean }) => api.paymentGateways.update(scope.storeId!, 'nagad', { revision: account!.revision, ...input }),
    onSuccess: async (saved) => {
      toast(saved.enabled ? 'Nagad is on at checkout.' : 'Nagad is off at checkout.');
      await invalidate.gateways();
    },
    onError: async (e) => {
      toast(nagadErrorText(e, 'We couldn’t save this.'), 'error');
      await invalidate.gateways();
    },
  });
  const canToggle = connected && manage && !update.isPending;
  return (
    <Panel title="Checkout options" description="How shoppers pay with Nagad.">
      <div>
        <SettingRow
          title="Pay with Nagad wallet"
          description={connected ? 'Number, OTP and PIN on Nagad’s secure page' : 'Connect Nagad first'}
          control={<Toggle label="Pay with Nagad wallet" checked={!!account?.enabled} disabled={!canToggle} onChange={(v) => update.mutate({ enabled: v })} />}
        />
        <SettingRow
          title="Default for payment links"
          description="Used first when you ask for an advance"
          control={<Toggle label="Default for payment links" checked={!!account?.is_default} disabled={!canToggle} onChange={(v) => update.mutate({ is_default: v })} />}
        />
        <SettingRow
          title="Refunds from Storeplix"
          description={has('refund') ? (has('refund_partial') ? 'Full or partial refund to the shopper’s Nagad wallet' : 'Full refund to the shopper’s Nagad wallet') : 'Refund in the Nagad portal, then record a manual refund'}
          control={<Toggle label="Refunds from Storeplix" checked={has('refund')} disabled />}
        />
        <Greyed title="Remember the shopper’s number" on={false} />
        <Greyed title="Pre-authorise advance" on={has('preauth')} />
        <Greyed title="Agreement checkout" on={has('agreement')} />
      </div>
      {account?.mode === 'sandbox' && account.enabled && (
        <p className="flex items-center gap-2 text-caption text-warning">
          <AlertTriangle aria-hidden className="size-3.5" /> Sandbox payments are tests. Replace with your live keys before real shoppers pay.
        </p>
      )}
    </Panel>
  );
}

/** A capability no built driver offers (P89D-45): greyed and off, never faked. */
function Greyed({ title, on }: { title: string; on: boolean }) {
  return (
    <div className={cn(!on && 'opacity-60')}>
      <SettingRow title={title} description={on ? 'Offered by your Nagad agreement' : NOT_OFFERED} control={<Toggle label={title} checked={on} disabled />} />
    </div>
  );
}

function DisconnectDialog({ onClose }: { onClose: () => void }) {
  const { storeId } = useStoreScope();
  const invalidate = usePaymentInvalidate();
  const disconnect = useMutation({
    mutationFn: () => api.paymentGateways.disconnect(storeId!, 'nagad'),
    onSuccess: async () => {
      toast('Nagad disconnected. Its keys were deleted.');
      await invalidate.gateways();
      onClose();
    },
  });
  return (
    <Dialog
      open
      size="sm"
      tone="danger"
      icon={<AlertTriangle />}
      title="Disconnect Nagad?"
      description="Shoppers can’t pay with Nagad any more and your saved keys are deleted. Past payments stay on their orders."
      confirmLabel="Disconnect"
      cancelLabel="Keep connected"
      loading={disconnect.isPending}
      onCancel={() => !disconnect.isPending && onClose()}
      onConfirm={() => disconnect.mutate()}
    >
      {disconnect.error ? (
        <p role="alert" className="text-caption text-danger">
          {nagadErrorText(disconnect.error, 'We couldn’t disconnect.')}
        </p>
      ) : null}
    </Dialog>
  );
}

export default NagadPage;
