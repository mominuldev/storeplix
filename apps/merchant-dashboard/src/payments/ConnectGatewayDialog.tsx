import { isApiError } from '@storeplix/api-client';
import type { GatewayProvider, IntegrationMode, PaymentGatewayAccount } from '@storeplix/types';
import { Badge, Button, cn, Dialog, Input, ProviderLogo, SecretField, SegmentedControl, Spinner, Toggle, WizardModal } from '@storeplix/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, CheckCircle2, ExternalLink, ShieldCheck } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { dateTime } from '../catalog/format';
import { keys, useStoreScope } from '../catalog/scope';
import { errorMessage } from '../catalog/states';
import { newIdempotencyKey } from '../commerce/format';
import { api } from '../lib/api';
import { toast } from '../online-store/components/Toast';
import { byProvider, gatewayMeta, modeLabel } from './gateways';
import { usePaymentGateways, usePaymentInvalidate } from './queries';

// Figma Integrations · Connect bKash 32:3770 (wizard 32:4105). 4-step rail: Before you start → Enter credentials
// (Sandbox/Live, fields per provider, "Encrypted and used only…") → Test payment (opens `redirect_url` in a new tab
// and polls the account until `verified_at` moves) → Go live (enable for checkout, default gateway). "Save and test"
// = PUT. Secrets are write-only: typed values are cleared after a save and never filled from the server (P5B-10).
// Not built: "Setup guide ↗" (docs page later, §10), per-field green checks (no per-field validation API).

type Step = 1 | 2 | 3 | 4;
const STEPS = ['Before you start', 'Enter credentials', 'Test payment', 'Go live'] as const;

export interface ConnectGatewayDialogProps {
  provider: GatewayProvider;
  account: PaymentGatewayAccount | undefined;
  onClose: () => void;
}

export function ConnectGatewayDialog({ provider, account: initial, onClose }: ConnectGatewayDialogProps) {
  const meta = gatewayMeta[provider];
  const titleId = useId();
  const [step, setStep] = useState<Step>(initial?.status === 'connected' ? 4 : 1);
  const [reached, setReached] = useState<Step>(initial?.status === 'connected' ? 4 : 1);
  const go = (s: Step) => {
    setStep(s);
    setReached((r) => (s > r ? s : r));
  };
  const [testing, setTesting] = useState(false);
  const gateways = usePaymentGateways({ refetchInterval: testing ? 3000 : false });
  const account = byProvider(gateways.data)[provider] ?? initial;
  const [baselineVerified] = useState(initial?.verified_at ?? null);
  const testPassed = !!account?.verified_at && (account.verified_at !== baselineVerified || !testing);
  const done = (s: Step) => s < reached || (s === 3 && testPassed) || (s === 2 && account?.status === 'connected');

  return (
    <WizardModal
      open
      onClose={onClose}
      labelledBy={titleId}
      aside={
        <>
          <ProviderLogo provider={provider} size="lg" />
          <div className="flex flex-col gap-0.5">
            <p className="text-heading text-text-primary">Connect {meta.short}</p>
            <p className="text-body text-text-secondary">Payment gateway</p>
          </div>
          <ol aria-label="Steps" className="flex gap-1 overflow-x-auto md:flex-col">
            {STEPS.map((label, i) => {
              const n = (i + 1) as Step;
              const current = n === step;
              const isDone = !current && done(n);
              const clickable = n <= reached && !current && !(n === 1 && account?.status === 'connected');
              return (
                <li key={label} className="shrink-0">
                  <button
                    type="button"
                    disabled={!clickable}
                    aria-current={current ? 'step' : undefined}
                    onClick={() => setStep(n)}
                    className={cn('flex w-full items-center gap-3 rounded-control p-2.5 text-left outline-none focus-visible:shadow-focus disabled:cursor-default', current && 'bg-surface-card shadow-elevation-1')}
                  >
                    <span
                      className={cn(
                        'flex size-[26px] shrink-0 items-center justify-center rounded-full text-caption font-medium',
                        isDone ? 'bg-success text-text-inverse' : current ? 'bg-brand-600 text-text-inverse' : 'bg-surface-subtle text-text-secondary',
                      )}
                    >
                      {isDone ? <Check aria-hidden strokeWidth={3} className="size-3.5" /> : n}
                    </span>
                    <span className={cn('text-body whitespace-nowrap', current ? 'font-semibold text-text-primary' : isDone ? 'text-text-primary' : 'text-text-muted')}>{label}</span>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="hidden flex-1 md:block" />
          <div className="hidden flex-col gap-1 rounded-lg bg-brand-50 p-3 text-caption md:flex">
            <p className="font-medium text-brand-700">Don’t have a merchant account?</p>
            <p className="text-text-secondary">{meta.applyNote}</p>
          </div>
        </>
      }
    >
      {step === 1 && <BeforeYouStart provider={provider} titleId={titleId} onNext={() => go(2)} onCancel={onClose} />}
      {step === 2 && <Credentials provider={provider} account={account} titleId={titleId} onBack={() => setStep(1)} onSaved={() => go(3)} />}
      {step === 3 && (
        <TestPayment
          provider={provider}
          account={account}
          titleId={titleId}
          testing={testing}
          passed={testPassed}
          onStart={() => setTesting(true)}
          onBack={() => setStep(2)}
          onNext={() => {
            setTesting(false);
            go(4);
          }}
        />
      )}
      {step === 4 && account && <GoLive provider={provider} account={account} others={(gateways.data ?? []).filter((a) => a.provider !== provider)} titleId={titleId} onEditKeys={() => go(2)} onDone={onClose} />}
    </WizardModal>
  );
}

function StepHeader({ n, titleId, title, subtitle }: { n: Step; titleId: string; title: string; subtitle?: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 pr-10">
      <p className="text-caption font-medium text-brand-600">Step {n} of 4</p>
      <h2 id={titleId} className="text-heading text-text-primary">
        {title}
      </h2>
      {subtitle && <p className="text-body text-text-secondary">{subtitle}</p>}
    </div>
  );
}

function Footer({ children, start }: { children: ReactNode; start?: ReactNode }) {
  return (
    <div className="mt-auto flex flex-wrap items-center gap-2.5 pt-2">
      {start}
      <span className="flex-1" />
      {children}
    </div>
  );
}

function Alert({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-control bg-danger-bg px-3.5 py-2.5 text-body text-danger">
      {children}
    </p>
  );
}

function BeforeYouStart({ provider, titleId, onNext, onCancel }: { provider: GatewayProvider; titleId: string; onNext: () => void; onCancel: () => void }) {
  const meta = gatewayMeta[provider];
  const needs =
    provider === 'bkash'
      ? ['A bKash merchant account with Tokenized Checkout (payment gateway) turned on', 'Your App key, App secret, Username and Password from bKash', 'A phone with a bKash sandbox or personal account for the test payment']
      : ['An approved SSLCommerz store (sandbox or live)', 'Your Store ID and Store password from SSLCommerz', 'A card or mobile wallet for the test payment'];
  return (
    <>
      <StepHeader n={1} titleId={titleId} title="Before you start" subtitle={`Connect your own ${meta.short} account. Customers pay into it directly.`} />
      <div className="flex flex-col gap-3">
        <p className="text-body font-medium text-text-primary">What you need</p>
        <ul className="flex flex-col gap-2.5">
          {needs.map((n) => (
            <li key={n} className="flex items-start gap-2.5 text-body text-text-secondary">
              <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-success" /> {n}
            </li>
          ))}
        </ul>
      </div>
      <p className="flex items-start gap-2.5 rounded-control bg-surface-canvas px-3.5 py-2.5 text-caption text-text-secondary">
        <ShieldCheck aria-hidden className="size-4 shrink-0 text-brand-600" /> Money goes straight to {meta.moneyTo}. Store Plix never holds it and adds no fee for your customers.
      </p>
      <p className="rounded-lg bg-brand-50 p-3 text-caption text-text-secondary md:hidden">
        <span className="font-medium text-brand-700">Don’t have a merchant account? </span>
        {meta.applyNote}
      </p>
      <Footer>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onNext}>Continue</Button>
      </Footer>
    </>
  );
}

function Credentials({ provider, account, titleId, onBack, onSaved }: { provider: GatewayProvider; account: PaymentGatewayAccount | undefined; titleId: string; onBack: () => void; onSaved: () => void }) {
  const meta = gatewayMeta[provider];
  const { storeId } = useStoreScope();
  const scope = useStoreScope();
  const qc = useQueryClient();
  const invalidate = usePaymentInvalidate();
  const [mode, setMode] = useState<IntegrationMode>(account?.mode ?? 'sandbox');
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const missing = meta.fields.some((f) => !(values[f.key] ?? '').trim());
  const save = useMutation({
    mutationFn: () =>
      api.paymentGateways.connect(storeId!, provider, {
        mode,
        credentials: Object.fromEntries(meta.fields.map((f) => [f.key, f.secret ? (values[f.key] ?? '') : (values[f.key] ?? '').trim()])) as never,
      }),
    onSuccess: async (saved) => {
      // Never keep secrets in memory after the API has them.
      setValues({});
      qc.setQueryData<PaymentGatewayAccount[]>(keys.paymentGateways(scope), (list) => (list ? list.map((a) => (a.provider === provider ? saved : a)) : list));
      toast(`${meta.short} connected. Your keys are saved and encrypted.`);
      await invalidate.gateways();
      onSaved();
    },
    onError: (e) => {
      if (isApiError(e) && e.status === 422) {
        const fieldErrors: Record<string, string> = {};
        for (const [k, m] of Object.entries(e.fieldErrors ?? {})) fieldErrors[k.replace(/^credentials\./, '')] = m[0] ?? '';
        setErrors(fieldErrors);
        return setFormError(e.code === 'credentials_invalid' ? `${meta.short} didn’t accept these keys. Check them in the merchant portal and try again.` : e.message);
      }
      setErrors({});
      if (isApiError(e) && e.code === 'provider_unavailable') return setFormError(`${meta.short} didn’t answer. Nothing was saved — try again in a minute.`);
      if (isApiError(e) && e.status === 403) return setFormError('Only owners and managers can connect payment accounts.');
      setFormError(errorMessage(e, 'We couldn’t save these keys.'));
    },
  });
  const set = (k: string, v: string) => {
    setValues((s) => ({ ...s, [k]: v }));
    setErrors((s) => ({ ...s, [k]: '' }));
  };
  const wide = (k: string) => provider === 'sslcommerz' || k === 'app_key' || k === 'app_secret';
  return (
    <form
      className="flex flex-1 flex-col gap-[18px]"
      onSubmit={(e) => {
        e.preventDefault();
        if (!missing) save.mutate();
      }}
    >
      <StepHeader n={2} titleId={titleId} title={`Enter your ${meta.short} credentials`} subtitle={meta.portalHint} />
      <SegmentedControl
        aria-label="Mode"
        size="sm"
        className="self-start"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'sandbox', label: 'Sandbox (test)' },
          { value: 'live', label: 'Live' },
        ]}
      />
      {account?.credentials_hint && (
        <p className="text-caption text-text-muted">
          Saved keys end in <span className="font-medium text-text-secondary">{account.credentials_hint}</span>. Enter all fields again to replace them.
        </p>
      )}
      <div className="grid gap-[18px] sm:grid-cols-2">
        {meta.fields.map((f) =>
          f.secret ? (
            <SecretField
              key={f.key}
              id={`gw-${f.key}`}
              label={f.label}
              maxLength={f.max}
              placeholder={f.placeholder}
              hint={f.hint}
              error={errors[f.key] || undefined}
              value={values[f.key] ?? ''}
              onChange={(v) => set(f.key, v)}
              containerClassName={wide(f.key) ? 'sm:col-span-2' : undefined}
            />
          ) : (
            <Input
              key={f.key}
              id={`gw-${f.key}`}
              label={f.label}
              maxLength={f.max}
              autoComplete="off"
              spellCheck={false}
              placeholder={f.placeholder}
              hint={f.hint}
              error={errors[f.key] || undefined}
              value={values[f.key] ?? ''}
              onChange={(e) => set(f.key, e.target.value)}
              containerClassName={wide(f.key) ? 'sm:col-span-2' : undefined}
            />
          ),
        )}
      </div>
      <p className="flex items-center gap-2.5 rounded-control bg-surface-canvas px-3.5 py-2.5 text-caption text-text-secondary">
        <ShieldCheck aria-hidden className="size-4 shrink-0 text-brand-600" /> Encrypted and used only to start payments for your shop. Money goes straight to {meta.moneyTo}.
      </p>
      {mode === 'live' && <p className="text-caption text-warning">Live mode takes real money. Use your live keys from {meta.short}.</p>}
      {formError && <Alert>{formError}</Alert>}
      <Footer>
        <Button variant="secondary" onClick={onBack} disabled={save.isPending}>
          Back
        </Button>
        <Button type="submit" loading={save.isPending} disabled={missing}>
          Save and test
        </Button>
      </Footer>
    </form>
  );
}

function TestPayment({
  provider,
  account,
  titleId,
  testing,
  passed,
  onStart,
  onBack,
  onNext,
}: {
  provider: GatewayProvider;
  account: PaymentGatewayAccount | undefined;
  titleId: string;
  testing: boolean;
  passed: boolean;
  onStart: () => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const meta = gatewayMeta[provider];
  const { storeId } = useStoreScope();
  const [key, setKey] = useState(newIdempotencyKey);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = account?.mode === 'live';
  const start = useMutation({
    mutationFn: (_tab: Window | null) => api.paymentGateways.testPayment(storeId!, provider, key),
    onSuccess: (res, tab) => {
      setKey(newIdempotencyKey());
      setUrl(res.redirect_url);
      setError(null);
      onStart();
      if (tab) {
        tab.opener = null;
        tab.location.href = res.redirect_url;
      }
    },
    onError: (e, tab) => {
      tab?.close();
      if (isApiError(e) && e.code === 'provider_unavailable') return setError(`${meta.short} didn’t answer. Try again in a minute.`);
      setError(errorMessage(e, 'We couldn’t start the test payment.'));
    },
  });
  return (
    <>
      <StepHeader
        n={3}
        titleId={titleId}
        title="Make a test payment"
        subtitle={live ? `Pay ৳ 1 from your own ${meta.short} account. It’s refunded automatically where ${meta.short} allows it.` : `Pay ৳ 10 with a ${meta.short} sandbox account. No real money moves.`}
      />
      <div aria-live="polite" className="flex flex-col gap-3 rounded-lg border border-border-default p-4">
        {passed ? (
          <p className="flex items-center gap-2.5 text-body font-semibold text-success">
            <CheckCircle2 aria-hidden className="size-5" /> Test payment received{account?.verified_at ? ` · ${dateTime(account.verified_at)}` : ''}
          </p>
        ) : testing ? (
          <>
            <p className="flex items-center gap-2.5 text-body font-medium text-text-primary">
              <Spinner label="Waiting" className="size-4" /> Waiting for the payment… finish it in the new tab.
            </p>
            {url && (
              <a href={url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-caption font-medium text-brand-600 hover:underline">
                Open the payment page again <ExternalLink aria-hidden className="size-3.5" />
              </a>
            )}
          </>
        ) : (
          <p className="text-body text-text-secondary">We open the {meta.short} payment page in a new tab. Come back here when you’ve paid — this step ticks itself.</p>
        )}
        {!passed && (
          <Button variant={testing ? 'secondary' : 'primary'} className="self-start" loading={start.isPending} onClick={() => start.mutate(window.open('', '_blank'))}>
            {testing ? 'Start another test payment' : 'Start test payment'}
          </Button>
        )}
      </div>
      {error && <Alert>{error}</Alert>}
      <Footer>
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
        <Button variant={passed ? 'primary' : 'secondary'} onClick={onNext}>
          {passed ? 'Continue' : 'Skip for now'}
        </Button>
      </Footer>
    </>
  );
}

function GoLive({ provider, account, others, titleId, onEditKeys, onDone }: { provider: GatewayProvider; account: PaymentGatewayAccount; others: PaymentGatewayAccount[]; titleId: string; onEditKeys: () => void; onDone: () => void }) {
  const meta = gatewayMeta[provider];
  const { storeId } = useStoreScope();
  const invalidate = usePaymentInvalidate();
  const firstTime = !account.enabled && !account.is_default;
  const [enabled, setEnabled] = useState(account.enabled || firstTime);
  const [isDefault, setIsDefault] = useState(account.is_default || (firstTime && !others.some((o) => o.is_default && o.status === 'connected')));
  const [error, setError] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const changed = enabled !== account.enabled || isDefault !== account.is_default;
  const save = useMutation({
    mutationFn: () => api.paymentGateways.update(storeId!, provider, { revision: account.revision, enabled, is_default: isDefault }),
    onSuccess: async () => {
      toast(enabled ? `${meta.short} is on at checkout.` : `${meta.short} saved.`);
      await invalidate.gateways();
      onDone();
    },
    onError: async (e) => {
      if (isApiError(e) && e.code === 'revision_conflict') {
        await invalidate.gateways();
        return setError('Someone else changed this gateway. We loaded the latest — check and save again.');
      }
      if (isApiError(e) && e.code === 'gateway_not_connected') return setError(`${meta.short} isn’t ready for checkout yet. Save working keys first (live mode needs a passed check).`);
      setError(errorMessage(e, 'We couldn’t save this.'));
    },
  });
  const disconnect = useMutation({
    mutationFn: () => api.paymentGateways.disconnect(storeId!, provider),
    onSuccess: async () => {
      toast(`${meta.short} disconnected. Its keys were deleted.`);
      await invalidate.gateways();
      onDone();
    },
    onError: (e) => {
      setConfirmDisconnect(false);
      setError(isApiError(e) && e.code === 'gateway_busy' ? `${meta.short} still has payments or refunds in progress. Try again once they finish.` : errorMessage(e, 'We couldn’t disconnect.'));
    },
  });
  return (
    <>
      <StepHeader n={4} titleId={titleId} title="Go live" subtitle={`Choose where customers see ${meta.short}.`} />
      <dl className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border-default px-4 py-3 text-body">
        <div className="flex items-center gap-2">
          <dt className="sr-only">Status</dt>
          <dd>
            <Badge tone="success" dot>
              Connected
            </Badge>
          </dd>
        </div>
        <div>
          <dt className="sr-only">Mode</dt>
          <dd className="text-text-primary">{account.mode ? modeLabel[account.mode] : '—'}</dd>
        </div>
        {account.credentials_hint && (
          <div className="flex gap-1">
            <dt className="text-text-muted">Keys</dt>
            <dd className="text-text-primary">{account.credentials_hint}</dd>
          </div>
        )}
        <div className="flex gap-1">
          <dt className="text-text-muted">Test</dt>
          <dd className="text-text-primary">{account.verified_at ? 'Passed' : 'Not done'}</dd>
        </div>
        <button type="button" onClick={onEditKeys} className="ml-auto text-caption font-medium text-brand-600 hover:underline">
          Edit keys
        </button>
      </dl>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-4 rounded-lg border border-border-default p-4">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-body font-semibold text-text-primary">Show at checkout</span>
            <span className="text-caption text-text-muted">
              Customers see “{meta.checkoutLabel}” and pay the full amount online. Paid orders confirm themselves.
            </span>
          </span>
          <Toggle label="Show at checkout" checked={enabled} onChange={setEnabled} />
        </div>
        <div className="flex items-center gap-4 rounded-lg border border-border-default p-4">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-body font-semibold text-text-primary">Default gateway</span>
            <span className="text-caption text-text-muted">Used first for advance payment links</span>
          </span>
          <Toggle label="Default gateway" checked={isDefault} onChange={setIsDefault} />
        </div>
      </div>
      {account.mode === 'sandbox' && enabled && <p className="text-caption text-warning">Sandbox payments are tests. Switch to Live with your live keys before real customers pay.</p>}
      {error && <Alert>{error}</Alert>}
      <Footer
        start={
          <Button variant="ghost" className="text-danger" onClick={() => setConfirmDisconnect(true)} disabled={save.isPending}>
            Disconnect
          </Button>
        }
      >
        <Button loading={save.isPending} onClick={() => (changed ? save.mutate() : onDone())}>
          {changed ? 'Save' : 'Done'}
        </Button>
      </Footer>
      <Dialog
        open={confirmDisconnect}
        tone="danger"
        title={`Disconnect ${meta.short}?`}
        description={`Customers can’t pay with ${meta.short} any more and your saved keys are deleted. Past payments stay on their orders.`}
        confirmLabel="Disconnect"
        loading={disconnect.isPending}
        onCancel={() => setConfirmDisconnect(false)}
        onConfirm={() => disconnect.mutate()}
      />
    </>
  );
}
