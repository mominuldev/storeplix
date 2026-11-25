import { isApiError } from '@storeplix/api-client';
import type { CourierAccount, CourierProvider, IntegrationMode } from '@storeplix/types';
import { Badge, Button, cn, CopyField, Dialog, Input, ProviderLogo, SecretField, SegmentedControl, Select, Spinner, Toggle, WizardModal } from '@storeplix/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, CheckCircle2, RefreshCw, ShieldCheck } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { dateTime } from '../catalog/format';
import { keys, useStoreScope } from '../catalog/scope';
import { errorMessage } from '../catalog/states';
import { timeAgo } from '../commerce/format';
import { useShipping } from '../commerce/queries';
import { api } from '../lib/api';
import { toast } from '../online-store/components/Toast';
import { handlePlanLimit } from '../plan/Banners';
import {
  courierConnected,
  courierErrorMessage,
  courierMeta,
  couriersByProvider,
  courierStatusMeta,
  DESCRIPTION_MAX,
  renderDescription,
  rulesDraft,
  rulesErrors,
  rulesInput,
  weightBounds,
  type RulesDraft,
  type RulesErrors,
} from './couriers';
import { useCourierInvalidate, useCourierPickupStores, useCouriers } from './queries';

// Courier connect + manage dialog (PHASE-5B §10, P5B-31/32/37). Built in the connect-wizard frame (32:4105, as bKash
// 32:3770) with the content of the courier detail page: Connection card (22:1181 Overview: masked keys, Edit keys,
// Test connection, Disconnect), Booking rules card (22:1181, limited per §10 to Pickup from, Cash to collect (fixed
// "Order due amount"), Parcel description template, Default weight; plus Pathao store / delivery type / item type
// (152:34534) and RedX pickup store), Status webhook card (31:2905: URL + Copy, Bearer token masked with Rotate).
// First connect walks the three sections in order; a connected account opens on Connection and every section is
// reachable. Secrets are write-only: typed keys are cleared after a save; the webhook secret from `meta` (or Rotate)
// lives only in this dialog's state and is dropped when the merchant leaves the section or closes the dialog.
// Not built (§14): Book automatically, Bulk booking switch, Print label after booking, Fraud check, COD & payouts,
// Activity log, Connection health, Send test event, Setup guide links.

type Section = 'connection' | 'rules' | 'webhook';
const SECTIONS: { value: Section; label: string }[] = [
  { value: 'connection', label: 'Enter credentials' },
  { value: 'rules', label: 'Booking rules' },
  { value: 'webhook', label: 'Status updates' },
];

export interface CourierDialogProps {
  provider: CourierProvider;
  account: CourierAccount | undefined;
  onClose: () => void;
}

export function CourierDialog({ provider, account: initial, onClose }: CourierDialogProps) {
  const meta = courierMeta[provider];
  const titleId = useId();
  const couriers = useCouriers();
  const account = couriersByProvider(couriers.data)[provider] ?? initial;
  const [firstRun] = useState(!courierConnected(initial));
  const connected = courierConnected(account);
  const [section, setSection] = useState<Section>('connection');
  const [reached, setReached] = useState(firstRun ? 0 : 2);
  const [secret, setSecret] = useState<{ value: string; url: string | null } | null>(null);
  const go = (s: Section) => {
    // The one-time secret is shown on the Status updates section only; leaving it drops the value for good.
    if (s !== 'webhook') setSecret(null);
    setSection(s);
    setReached((r) => Math.max(r, SECTIONS.findIndex((x) => x.value === s)));
  };
  const status = courierStatusMeta(account?.status ?? 'not_connected');
  const step = SECTIONS.findIndex((x) => x.value === section) + 1;

  return (
    <WizardModal
      open
      onClose={onClose}
      labelledBy={titleId}
      aside={
        <>
          <ProviderLogo provider={provider} size="lg" />
          <div className="flex flex-col items-start gap-1">
            <p className="text-heading text-text-primary">{firstRun ? `Connect ${meta.short}` : meta.name}</p>
            <p className="text-body text-text-secondary">Courier</p>
            {connected && (
              <Badge tone={status.tone} dot>
                {status.label}
              </Badge>
            )}
          </div>
          <ol aria-label="Sections" className="flex gap-1 overflow-x-auto md:flex-col">
            {SECTIONS.map((s, i) => {
              const current = s.value === section;
              const isDone = !current && connected && i <= reached && (i > 0 || firstRun);
              const clickable = !current && connected && i <= reached;
              return (
                <li key={s.value} className="shrink-0">
                  <button
                    type="button"
                    disabled={!clickable}
                    aria-current={current ? 'step' : undefined}
                    onClick={() => go(s.value)}
                    className={cn('flex w-full items-center gap-3 rounded-control p-2.5 text-left outline-none focus-visible:shadow-focus disabled:cursor-default', current && 'bg-surface-card shadow-elevation-1')}
                  >
                    <span
                      className={cn(
                        'flex size-[26px] shrink-0 items-center justify-center rounded-full text-caption font-medium',
                        isDone && firstRun ? 'bg-success text-text-inverse' : current ? 'bg-brand-600 text-text-inverse' : 'bg-surface-subtle text-text-secondary',
                      )}
                    >
                      {isDone && firstRun ? <Check aria-hidden strokeWidth={3} className="size-3.5" /> : i + 1}
                    </span>
                    <span className={cn('text-body whitespace-nowrap', current ? 'font-semibold text-text-primary' : clickable ? 'text-text-primary' : 'text-text-muted')}>
                      {i === 0 && !firstRun ? 'Connection' : s.label}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="hidden flex-1 md:block" />
          <p className="hidden items-start gap-2 rounded-lg bg-brand-50 p-3 text-caption text-text-secondary md:flex">
            <ShieldCheck aria-hidden className="size-4 shrink-0 text-brand-600" /> Your own {meta.short} account. COD money goes from {meta.short} straight to you — Store Plix never holds it.
          </p>
        </>
      }
    >
      {section === 'connection' &&
        (connected && account ? (
          <ConnectionSummary
            provider={provider}
            account={account}
            titleId={titleId}
            onSaved={(s) => {
              if (s) {
                go('webhook');
                setSecret(s);
              }
            }}
            onDisconnected={onClose}
          />
        ) : (
          <Credentials
            provider={provider}
            account={account}
            titleId={titleId}
            step={firstRun ? step : null}
            onCancel={onClose}
            onPlanLimit={onClose}
            onSaved={(s) => {
              go('rules');
              setSecret(s);
            }}
          />
        ))}
      {section === 'rules' && account && connected && (
        <BookingRules
          provider={provider}
          account={account}
          titleId={titleId}
          step={firstRun ? step : null}
          onSaved={() => {
            if (firstRun) go('webhook');
          }}
          onBack={firstRun ? () => go('webhook') : () => go('connection')}
        />
      )}
      {section === 'webhook' && account && connected && (
        <StatusUpdates provider={provider} account={account} titleId={titleId} step={firstRun ? step : null} secret={secret} onSecret={setSecret} onDone={onClose} />
      )}
    </WizardModal>
  );
}

function Header({ titleId, step, title, subtitle }: { titleId: string; step: number | null; title: string; subtitle?: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 pr-10">
      {step !== null && <p className="text-caption font-medium text-brand-600">Step {step} of 3</p>}
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

function Passed({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="flex items-center gap-2.5 rounded-control bg-success-bg px-3.5 py-2.5 text-body text-success">
      <CheckCircle2 aria-hidden className="size-4 shrink-0" /> {children}
    </p>
  );
}

// ---------- Credentials (PUT) ----------

function Credentials({
  provider,
  account,
  titleId,
  step,
  onSaved,
  onCancel,
  onPlanLimit,
}: {
  provider: CourierProvider;
  account: CourierAccount | undefined;
  titleId: string;
  step: number | null;
  onSaved: (secret: { value: string; url: string | null } | null) => void;
  onCancel: () => void;
  onPlanLimit: () => void;
}) {
  const meta = courierMeta[provider];
  const scope = useStoreScope();
  const qc = useQueryClient();
  const invalidate = useCourierInvalidate();
  // Steadfast has no sandbox (its only host is live), so the API accepts only `live` for it.
  const liveOnly = provider === 'steadfast';
  const [mode, setMode] = useState<IntegrationMode>(liveOnly ? 'live' : (account?.mode ?? 'live'));
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const missing = meta.fields.some((f) => !(values[f.key] ?? '').trim());
  const save = useMutation({
    mutationFn: () =>
      api.couriers.connect(scope.storeId!, provider, {
        mode,
        credentials: Object.fromEntries(meta.fields.map((f) => [f.key, f.secret ? (values[f.key] ?? '') : (values[f.key] ?? '').trim()])) as never,
      }),
    onSuccess: async (res) => {
      setValues({}); // never keep secrets in memory after the API has them
      qc.setQueryData<CourierAccount[]>(keys.couriers(scope), (list) => (list ? list.map((a) => (a.provider === provider ? res.account : a)) : list));
      toast(`${meta.short} connected. Your keys are saved and encrypted.`);
      onSaved(res.webhook_secret ? { value: res.webhook_secret, url: res.account.webhook_url } : null);
      await invalidate();
    },
    onError: (e) => {
      if (handlePlanLimit(e)) return onPlanLimit();
      if (isApiError(e) && e.status === 422) {
        const fieldErrors: Record<string, string> = {};
        for (const [k, m] of Object.entries(e.fieldErrors ?? {})) fieldErrors[k.replace(/^credentials\./, '')] = m[0] ?? '';
        setErrors(fieldErrors);
        return setFormError(courierErrorMessage(e.code, meta.short) ?? e.message);
      }
      setErrors({});
      if (isApiError(e) && e.status === 403) return setFormError('Only owners and managers can connect couriers.');
      setFormError((isApiError(e) && courierErrorMessage(e.code, meta.short)) || errorMessage(e, 'We couldn’t save these keys.'));
    },
  });
  const set = (k: string, v: string) => {
    setValues((s) => ({ ...s, [k]: v }));
    setErrors((s) => ({ ...s, [k]: '' }));
  };
  return (
    <form
      className="flex flex-1 flex-col gap-[18px]"
      onSubmit={(e) => {
        e.preventDefault();
        if (!missing) save.mutate();
      }}
    >
      <Header titleId={titleId} step={step} title={account?.credentials_hint ? `Replace your ${meta.short} keys` : `Enter your ${meta.short} credentials`} subtitle={meta.portalHint} />
      {liveOnly ? (
        <p className="text-caption text-text-secondary">Steadfast has no sandbox: connect with your live API keys. Parcels you book are real.</p>
      ) : (
        <SegmentedControl
          aria-label="Mode"
          size="sm"
          className="self-start"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'live', label: 'Live' },
            { value: 'sandbox', label: 'Sandbox (test)' },
          ]}
        />
      )}
      {account?.credentials_hint && (
        <p className="text-caption text-text-muted">
          Saved keys end in <span className="font-medium text-text-secondary">{account.credentials_hint}</span>. Enter all fields again to replace them.
        </p>
      )}
      <div className="grid gap-[18px] sm:grid-cols-2">
        {meta.fields.map((f) => {
          const wide = meta.fields.length !== 4;
          return f.secret ? (
            <SecretField
              key={f.key}
              id={`courier-${f.key}`}
              label={f.label}
              maxLength={f.max}
              error={errors[f.key] || undefined}
              value={values[f.key] ?? ''}
              onChange={(v) => set(f.key, v)}
              containerClassName={wide ? 'sm:col-span-2' : undefined}
            />
          ) : (
            <Input
              key={f.key}
              id={`courier-${f.key}`}
              label={f.label}
              maxLength={f.max}
              autoComplete="off"
              spellCheck={false}
              type={f.key === 'username' ? 'email' : 'text'}
              error={errors[f.key] || undefined}
              value={values[f.key] ?? ''}
              onChange={(e) => set(f.key, e.target.value)}
              containerClassName={wide ? 'sm:col-span-2' : undefined}
            />
          );
        })}
      </div>
      <p className="flex items-center gap-2.5 rounded-control bg-surface-canvas px-3.5 py-2.5 text-caption text-text-secondary">
        <ShieldCheck aria-hidden className="size-4 shrink-0 text-brand-600" /> Keys are encrypted and only used to call {meta.short} for this shop. We check them before saving.
      </p>
      {mode === 'sandbox' && <p className="text-caption text-warning">Sandbox parcels are tests: no rider comes. Switch to Live with your live keys before you book real parcels.</p>}
      {formError && <Alert>{formError}</Alert>}
      <Footer>
        <Button variant="secondary" onClick={onCancel} disabled={save.isPending}>
          Cancel
        </Button>
        <Button type="submit" loading={save.isPending} disabled={missing}>
          Save and test
        </Button>
      </Footer>
    </form>
  );
}

// ---------- Connection summary (22:1181 Connection card) ----------

function ConnectionSummary({
  provider,
  account,
  titleId,
  onSaved,
  onDisconnected,
}: {
  provider: CourierProvider;
  account: CourierAccount;
  titleId: string;
  onSaved: (secret: { value: string; url: string | null } | null) => void;
  onDisconnected: () => void;
}) {
  const meta = courierMeta[provider];
  const { storeId } = useStoreScope();
  const invalidate = useCourierInvalidate();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passed, setPassed] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const test = useMutation({
    mutationFn: () => api.couriers.test(storeId!, provider),
    onSuccess: async (res) => {
      setError(null);
      if (!res.ok) {
        setPassed(null);
        setError(courierErrorMessage('credentials_invalid', meta.short));
      } else {
        const balance = typeof res.balance_amount === 'number' ? ` · balance ৳ ${(res.balance_amount / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '';
        setPassed(`Connection test passed · ${dateTime(res.checked_at)}${balance}`);
      }
      await invalidate();
    },
    onError: (e) => {
      setPassed(null);
      setError((isApiError(e) && courierErrorMessage(e.code, meta.short)) || errorMessage(e, 'We couldn’t test the connection.'));
    },
  });
  const disconnect = useMutation({
    mutationFn: () => api.couriers.disconnect(storeId!, provider),
    onSuccess: async () => {
      toast(`${meta.short} disconnected. Its keys were deleted.`);
      await invalidate();
      onDisconnected();
    },
    onError: (e) => {
      setConfirmDisconnect(false);
      setError((isApiError(e) && courierErrorMessage(e.code, meta.short)) || errorMessage(e, 'We couldn’t disconnect.'));
    },
  });

  if (editing) {
    return (
      <Credentials
        provider={provider}
        account={account}
        titleId={titleId}
        step={null}
        onCancel={() => setEditing(false)}
        onPlanLimit={() => setEditing(false)}
        onSaved={(s) => {
          setEditing(false);
          onSaved(s);
        }}
      />
    );
  }
  return (
    <>
      <Header titleId={titleId} step={null} title="Connection" subtitle={`Keys are encrypted and only used to call ${meta.short} for this shop.`} />
      <dl className="grid gap-x-6 gap-y-3 rounded-lg border border-border-default p-4 text-body sm:grid-cols-2">
        <Fact label="Mode">{account.mode === 'sandbox' ? 'Sandbox (test)' : 'Live mode'}</Fact>
        <Fact label="Keys">{account.credentials_hint ?? '—'}</Fact>
        <Fact label="Connected">
          {account.connected_at ? dateTime(account.connected_at) : '—'}
          {account.connected_by ? ` by ${account.connected_by.name}` : ''}
        </Fact>
        <Fact label="Last sync">{account.last_synced_at ? timeAgo(account.last_synced_at) : 'Not yet'}</Fact>
        <div className="sm:col-span-2">
          <button type="button" onClick={() => setEditing(true)} className="text-caption font-medium text-brand-600 hover:underline">
            Edit keys
          </button>
        </div>
      </dl>
      {account.status === 'error' && !passed && <Alert>The last check with {meta.short} failed. Test the connection, or edit the keys if they changed.</Alert>}
      {passed && <Passed>{passed}</Passed>}
      {error && <Alert>{error}</Alert>}
      <Footer
        start={
          <Button variant="ghost" className="text-danger" onClick={() => setConfirmDisconnect(true)} disabled={test.isPending}>
            Disconnect
          </Button>
        }
      >
        <Button loading={test.isPending} onClick={() => test.mutate()}>
          Test connection
        </Button>
      </Footer>
      <Dialog
        open={confirmDisconnect}
        tone="danger"
        title={`Disconnect ${meta.short}?`}
        description={`You can’t book ${meta.short} parcels from Store Plix any more and your saved keys are deleted. Parcels already delivered stay on their orders.`}
        confirmLabel="Disconnect"
        loading={disconnect.isPending}
        onCancel={() => setConfirmDisconnect(false)}
        onConfirm={() => disconnect.mutate()}
      />
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-caption text-text-muted">{label}</dt>
      <dd className="break-words text-text-primary">{children}</dd>
    </div>
  );
}

// ---------- Booking rules (22:1181, PATCH) ----------

function RuleRow({ label, description, htmlFor, children }: { label: string; description: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-b border-border-default py-3.5 last:border-b-0 sm:flex-row sm:items-start sm:gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <label htmlFor={htmlFor} className="text-body font-semibold text-text-primary">
          {label}
        </label>
        <p className="text-caption text-text-muted">{description}</p>
      </div>
      <div className="w-full sm:w-[240px] sm:shrink-0">{children}</div>
    </div>
  );
}

function BookingRules({ provider, account, titleId, step, onSaved, onBack }: { provider: CourierProvider; account: CourierAccount; titleId: string; step: number | null; onSaved: () => void; onBack?: () => void }) {
  const meta = courierMeta[provider];
  const scope = useStoreScope();
  const qc = useQueryClient();
  const invalidate = useCourierInvalidate();
  const shipping = useShipping();
  const pickups = shipping.data?.pickup_locations ?? [];
  const fallbackPickup = pickups.find((p) => p.is_default)?.id ?? pickups[0]?.id ?? null;
  const stores = useCourierPickupStores(provider, true);
  const [draft, setDraft] = useState<RulesDraft | null>(null);
  const d = draft ?? rulesDraft(account, fallbackPickup);
  const [errors, setErrors] = useState<RulesErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const set = <K extends keyof RulesDraft>(k: K, v: RulesDraft[K]) => {
    setDraft({ ...d, [k]: v });
    setErrors((e) => ({ ...e, [k]: undefined }));
  };
  const rendered = renderDescription(d.parcel_description);
  const { min, max } = weightBounds(provider);
  const save = useMutation({
    mutationFn: () => api.couriers.update(scope.storeId!, provider, { revision: account.revision, settings: rulesInput(provider, d), is_default: d.is_default }),
    onSuccess: async (saved) => {
      qc.setQueryData<CourierAccount[]>(keys.couriers(scope), (list) => (list ? list.map((a) => (a.provider === provider ? saved : a)) : list));
      setDraft(null);
      toast('Booking rules saved.');
      onSaved();
      await invalidate();
    },
    onError: async (e) => {
      if (isApiError(e) && e.code === 'revision_conflict') {
        setDraft(null);
        await invalidate();
        return setFormError(courierErrorMessage('revision_conflict', meta.short));
      }
      if (isApiError(e) && e.status === 422 && e.fieldErrors) {
        const next: RulesErrors = {};
        for (const [k, m] of Object.entries(e.fieldErrors)) next[k.replace(/^settings\./, '') as keyof RulesErrors] = m[0];
        setErrors(next);
      }
      setFormError((isApiError(e) && courierErrorMessage(e.code, meta.short)) || errorMessage(e, 'We couldn’t save the booking rules.'));
    },
  });
  const submit = () => {
    const problems = rulesErrors(provider, d);
    setErrors(problems);
    if (Object.keys(problems).length) return setFormError('Check the highlighted settings.');
    setFormError(null);
    save.mutate();
  };
  const storeOptions = stores.data ?? [];

  return (
    <form
      className="flex flex-1 flex-col gap-2"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Header titleId={titleId} step={step} title="Booking rules" subtitle={`How Store Plix sends orders to ${meta.short}.`} />
      <div className="flex flex-col">
        <RuleRow label="Pickup from" description={`Where the ${meta.short} rider collects parcels.`} htmlFor="courier-pickup">
          {shipping.isPending ? (
            <Spinner label="Loading pickup locations" className="size-4" />
          ) : pickups.length === 0 ? (
            <p className="text-caption text-danger">
              Save a pickup address first.{' '}
              <Link to="/settings/shipping" className="font-medium text-brand-600 hover:underline">
                Add one in Shipping
              </Link>
            </p>
          ) : (
            <Select id="courier-pickup" aria-label="Pickup from" value={d.pickup_location_id} error={errors.pickup_location_id} onChange={(e) => set('pickup_location_id', e.target.value)}>
              <option value="">Choose…</option>
              {pickups.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.thana}
                </option>
              ))}
            </Select>
          )}
        </RuleRow>
        {provider === 'pathao' && (
          <RuleRow label="Pathao store" description="The store in your Pathao account that parcels are booked under." htmlFor="courier-pathao-store">
            <CourierStoreSelect id="courier-pathao-store" label="Pathao store" query={stores} options={storeOptions} value={d.pathao_store_id} error={errors.pathao_store_id} onChange={(v) => set('pathao_store_id', v)} required />
          </RuleRow>
        )}
        {provider === 'redx' && (
          <RuleRow label="RedX pickup store" description="Leave on your RedX default unless you have several." htmlFor="courier-redx-store">
            <CourierStoreSelect id="courier-redx-store" label="RedX pickup store" query={stores} options={storeOptions} value={d.redx_pickup_store_id} error={errors.redx_pickup_store_id} onChange={(v) => set('redx_pickup_store_id', v)} />
          </RuleRow>
        )}
        <RuleRow label="Cash to collect" description="Amount the rider collects from the customer." htmlFor="courier-cod">
          <Select id="courier-cod" aria-label="Cash to collect" value="due" disabled>
            <option value="due">Order due amount</option>
          </Select>
        </RuleRow>
        {provider === 'pathao' && (
          <>
            <RuleRow label="Delivery type" description="Pathao’s service for new bookings." htmlFor="courier-delivery-type">
              <Select id="courier-delivery-type" aria-label="Delivery type" value={d.delivery_type} onChange={(e) => set('delivery_type', e.target.value as RulesDraft['delivery_type'])}>
                <option value="48">Normal delivery</option>
                <option value="12">On-demand delivery</option>
              </Select>
            </RuleRow>
            <RuleRow label="Item type" description="Documents aren’t booked from Store Plix." htmlFor="courier-item-type">
              <Select id="courier-item-type" aria-label="Item type" value="2" disabled>
                <option value="2">Parcel</option>
              </Select>
            </RuleRow>
          </>
        )}
        <RuleRow label="Parcel description" description="Shown on the label. Variables: {items}, {order_no}." htmlFor="courier-description">
          <Input
            id="courier-description"
            aria-label="Parcel description"
            value={d.parcel_description}
            maxLength={DESCRIPTION_MAX}
            error={errors.parcel_description}
            onChange={(e) => set('parcel_description', e.target.value)}
          />
          <p className="mt-1.5 text-caption break-words text-text-muted" aria-live="polite">
            On the label: <span className="text-text-secondary">{rendered.slice(0, DESCRIPTION_MAX) || '—'}</span>
            {rendered.length > DESCRIPTION_MAX && ` (cut to ${DESCRIPTION_MAX} characters)`}
          </p>
        </RuleRow>
        <RuleRow label="Default weight" description={`Used when you don’t enter one at booking. ${min} g to ${max / 1000} kg.`} htmlFor="courier-weight">
          <Input
            id="courier-weight"
            aria-label="Default weight"
            inputMode="numeric"
            value={d.default_weight_grams}
            error={errors.default_weight_grams}
            trailing={<span className="text-body text-text-muted">g</span>}
            onChange={(e) => set('default_weight_grams', e.target.value.replace(/[^\d]/g, ''))}
          />
        </RuleRow>
        <div className="flex items-center gap-4 py-3.5">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-body font-semibold text-text-primary">Default courier</span>
            <span className="text-caption text-text-muted">Picked first when you book a parcel.</span>
          </span>
          <Toggle label="Default courier" checked={d.is_default} onChange={(v) => set('is_default', v)} />
        </div>
      </div>
      {formError && <Alert>{formError}</Alert>}
      <Footer
        start={
          onBack && (
            <Button variant="secondary" onClick={onBack} disabled={save.isPending}>
              {step !== null ? 'Skip for now' : 'Back'}
            </Button>
          )
        }
      >
        <Button type="submit" loading={save.isPending} disabled={pickups.length === 0}>
          {step !== null ? 'Save and continue' : 'Save'}
        </Button>
      </Footer>
    </form>
  );
}

function CourierStoreSelect({
  id,
  label,
  query,
  options,
  value,
  error,
  onChange,
  required,
}: {
  id: string;
  label: string;
  query: { isPending: boolean; isError: boolean; refetch: () => unknown };
  options: { id: string; name: string; address: string | null }[];
  value: string;
  error?: string;
  onChange: (v: string) => void;
  required?: boolean;
}) {
  if (query.isPending) return <Spinner label={`Loading ${label.toLowerCase()}s`} className="size-4" />;
  if (query.isError)
    return (
      <p className="text-caption text-danger">
        We couldn’t load your stores.{' '}
        <button type="button" className="font-medium text-brand-600 hover:underline" onClick={() => void query.refetch()}>
          Try again
        </button>
      </p>
    );
  return (
    <Select id={id} aria-label={label} value={value} error={error} onChange={(e) => onChange(e.target.value)}>
      <option value="">{required ? 'Choose…' : 'Your default store'}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
          {o.address ? ` · ${o.address}` : ''}
        </option>
      ))}
    </Select>
  );
}

// ---------- Status updates (31:2905 Status webhook card) ----------

function StatusUpdates({
  provider,
  account,
  titleId,
  step,
  secret,
  onSecret,
  onDone,
}: {
  provider: CourierProvider;
  account: CourierAccount;
  titleId: string;
  step: number | null;
  secret: { value: string; url: string | null } | null;
  onSecret: (s: { value: string; url: string | null } | null) => void;
  onDone: () => void;
}) {
  const meta = courierMeta[provider];
  const { storeId } = useStoreScope();
  const invalidate = useCourierInvalidate();
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rotate = useMutation({
    mutationFn: () => api.couriers.rotateWebhookSecret(storeId!, provider),
    onSuccess: async (res) => {
      setConfirmRotate(false);
      setError(null);
      onSecret({ value: res.webhook_secret, url: res.webhook_url });
      await invalidate();
    },
    onError: (e) => {
      setConfirmRotate(false);
      setError(errorMessage(e, 'We couldn’t make a new secret.'));
    },
  });
  const url = secret?.url ?? account.webhook_url;

  return (
    <>
      <Header
        titleId={titleId}
        step={step}
        title="Status updates"
        subtitle={meta.webhookHint ?? `${meta.short} doesn’t send status updates to Store Plix yet, so we check every parcel with ${meta.short} every 15 minutes.`}
      />
      {meta.webhookHint ? (
        <>
          {url && <CopyField label="Webhook URL" value={url} onCopied={() => toast('Webhook URL copied.')} />}
          {secret ? (
            <div className="flex flex-col gap-2">
              <CopyField label={meta.secretLabel} value={secret.value} onCopied={() => toast(`${meta.secretLabel} copied.`)} />
              <p className="text-caption text-warning">Copy it now and paste it in {meta.short}. For your safety we won’t show it again.</p>
            </div>
          ) : (
            <div className="flex min-h-11 items-center gap-3 rounded-md border border-border-default px-3">
              <span className="text-body text-text-secondary">{meta.secretLabel}</span>
              <span className="min-w-0 flex-1 truncate text-body text-text-primary" aria-label={`${meta.secretLabel} (hidden)`}>
                {account.webhook_secret_hint ?? '••••••••'}
              </span>
              <button type="button" onClick={() => setConfirmRotate(true)} className="flex items-center gap-1 text-body font-medium text-brand-600 hover:underline">
                <RefreshCw aria-hidden className="size-3.5" /> Rotate
              </button>
            </div>
          )}
          {account.last_webhook_at ? (
            <Passed>Last status update received {timeAgo(account.last_webhook_at)}</Passed>
          ) : (
            <p className="rounded-control bg-surface-canvas px-3.5 py-2.5 text-caption text-text-secondary">
              No status update received yet. We also check {meta.short} every 15 minutes, so no update is lost.
            </p>
          )}
        </>
      ) : (
        <p className="rounded-control bg-surface-canvas px-3.5 py-2.5 text-caption text-text-secondary">
          Tap “Sync now” on Shipments for a fresh check any time.
        </p>
      )}
      {error && <Alert>{error}</Alert>}
      <Footer>
        <Button onClick={onDone}>Done</Button>
      </Footer>
      <Dialog
        open={confirmRotate}
        title={`Make a new ${meta.secretLabel.toLowerCase()}?`}
        description={`The current one stops working at once. Paste the new one in ${meta.short} straight after, or status updates will fail until you do.`}
        confirmLabel="Make a new one"
        loading={rotate.isPending}
        onCancel={() => setConfirmRotate(false)}
        onConfirm={() => rotate.mutate()}
      />
    </>
  );
}
