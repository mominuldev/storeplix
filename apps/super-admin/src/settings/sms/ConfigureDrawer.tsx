import {
  SMS_MESSAGE_GROUP_LABELS,
  SMS_MESSAGE_GROUPS,
  SMS_PRIMARY_REQUIRED_GROUPS,
  type SmsHttpMapping,
  type SmsMessageGroup,
  type SmsProvider,
  type SmsProviderDriverCode,
  type SmsProviderDriverInfo,
  type SmsProviderOverview,
  type SmsProviderTestResult,
} from '@storeplix/types';
import { connectionKey, initialConfigureState, stepErrors, toCreateInput, type ConfigureState, type HttpCredRow, type Step } from './configure';
import { Badge, Button, Checkbox, cn, Drawer, Input, moneyToInput, SecretField, Select, Skeleton } from '@storeplix/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Info, Minus, Plus, PlugZap, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { LoggedAs } from '../../components/LoggedAs';
import { ErrorState } from '../../components/States';
import { api } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { ActivatePrimaryDialog, MutationError, ProviderTestResultCard } from './dialogs';
import { isHttpsUrl, normalizeBdPhone, perPart, providerInitials, testPhoneMemory } from './format';
import { platformSmsKeys, useDrivers } from './queries';
import { InlineAlert, PhoneField } from './ui';

// Configure provider drawer (PHASE-8-9B §11.2): Figma 2112:9494 (1 Choose) → 2112:9905 (2 Credentials) → 2113:9852
// (3 Route & senders) → 2113:10237 (4 Test & activate; 2113:10584 testing, 2113:10589 failed). 520 px right drawer,
// header icon tile + title + "Step n of 4 · …", compact 4-step row, footer "Logged as … · saved to the audit log"
// + Cancel / Back / Next. Coming-soon drivers are disabled (Q274); the DLR callback URL and "Delivery report" lines
// are hidden (Q267). Entering step 4 saves a draft (create, or update when only routing changed; a new draft when
// the connection changed — the old draft is removed).

const STEP_LABELS = ['Provider', 'Credentials', 'Senders', 'Activate'] as const;

export function ConfigureDrawer({ role, overview, onClose }: { role: 'primary' | 'failover'; overview: SmsProviderOverview | undefined; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const drivers = useDrivers();
  const [step, setStep] = useState<Step>(1);
  const [s, setS] = useState<ConfigureState>(() => initialConfigureState(role));
  const [showErrors, setShowErrors] = useState(false);
  const [draft, setDraft] = useState<{ provider: SmsProvider; key: string } | null>(null);
  const [phone, setPhone] = useState(testPhoneMemory.get());
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [test, setTest] = useState<SmsProviderTestResult | null>(null);
  const [activating, setActivating] = useState(false);

  const driver = drivers.data?.find((d) => d.code === s.driver);
  const errors = stepErrors(step, s, driver);
  const set = (patch: Partial<ConfigureState>) => setS((prev) => ({ ...prev, ...patch }));
  const err = (k: string) => (showErrors ? errors[k] : undefined);

  const saveDraft = useMutation({
    mutationFn: async (): Promise<{ provider: SmsProvider; key: string }> => {
      if (!driver) throw new Error('No driver');
      const input = toCreateInput(s, driver);
      const key = connectionKey(s);
      const p = api.admin.platformSms.providers;
      if (draft && draft.key === key) {
        const { driver: _d, credentials: _c, settings: _s, ...rest } = input;
        return { provider: await p.update(draft.provider.id, { ...rest, revision: draft.provider.revision }), key };
      }
      if (draft) await p.remove(draft.provider.id, { confirm_name: draft.provider.name });
      return { provider: await p.create(input), key };
    },
    onSuccess: (d) => {
      setDraft(d);
      setTest(null);
      setStep(4);
      void qc.invalidateQueries({ queryKey: platformSmsKeys.overview });
    },
  });

  const runTest = useMutation({
    mutationFn: (normalized: string) => api.admin.platformSms.providers.test(draft!.provider.id, { phone: normalized }),
    onSuccess: (r) => {
      setTest(r);
      if (draft) void api.admin.platformSms.providers.get(draft.provider.id).then((p) => setDraft({ ...draft, provider: p }), () => undefined);
    },
  });

  const activateFailover = useMutation({
    mutationFn: () => api.admin.platformSms.providers.activate(draft!.provider.id, { role: 'failover' }),
    onSuccess: (next) => {
      qc.setQueryData(platformSmsKeys.overview, next);
      void qc.invalidateQueries({ queryKey: platformSmsKeys.root });
      toast(`${draft!.provider.name} is now the failover provider`);
      onClose();
    },
  });

  const next = () => {
    if (Object.keys(errors).length) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    if (step === 3) saveDraft.mutate();
    else setStep((step + 1) as Step);
  };
  const back = () => {
    setShowErrors(false);
    setStep((Math.max(1, step - 1) as Step));
  };
  const sendTest = () => {
    const normalized = normalizeBdPhone(phone);
    if (!normalized) {
      setPhoneError('Enter a Bangladesh mobile number, e.g. 01711555211.');
      return;
    }
    setPhoneError(null);
    testPhoneMemory.set(phone);
    runTest.mutate(normalized);
  };
  const pickDriver = (d: SmsProviderDriverInfo) => {
    if (d.status !== 'available') return;
    const prev = drivers.data?.find((x) => x.code === s.driver);
    set({
      driver: d.code,
      name: !s.name || s.name === prev?.name ? d.name : s.name,
      baseUrl: !s.baseUrl || s.baseUrl === prev?.default_base_url ? (d.default_base_url ?? '') : s.baseUrl,
      credentials: {},
      priceMasking: moneyToInput(d.price_masking_paisa),
    });
  };

  const passed = test?.status === 'passed' || (draft?.provider.last_test?.status === 'passed' && !draft.provider.test_required);
  const subtitles: Record<Step, string> = {
    1: 'Pick the aggregator Storeplix sends through',
    2: `${driver?.name ?? 'Provider'} credentials`,
    3: `How Storeplix uses ${driver?.name ?? 'it'}`,
    4: 'Send a test, then activate',
  };

  const footer = (
    <div className="flex w-full flex-wrap items-center gap-2">
      <span className="flex-1">
        <LoggedAs suffix="saved to the audit log" />
      </span>
      <Button variant="ghost" onClick={onClose}>
        Cancel
      </Button>
      {step > 1 && (
        <Button variant="secondary" onClick={back} disabled={saveDraft.isPending}>
          Back
        </Button>
      )}
      {step < 4 ? (
        <Button onClick={next} loading={saveDraft.isPending}>
          Next
        </Button>
      ) : (
        <Button
          disabled={!passed || !draft}
          loading={activateFailover.isPending}
          onClick={() => (s.role === 'primary' ? setActivating(true) : activateFailover.mutate())}
        >
          Activate {draft?.provider.name ?? ''}
        </Button>
      )}
    </div>
  );

  return (
    <>
      <Drawer
        open
        onClose={onClose}
        width={520}
        title={
          <span className="flex items-center gap-3">
            <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-brand-50 text-brand-600">
              <PlugZap className="size-5" />
            </span>
            Configure SMS provider
          </span>
        }
        description={`Step ${step} of 4 · ${subtitles[step]}`}
        footer={footer}
      >
        <div className="flex flex-col gap-4 px-4 py-4 sm:px-5">
          <StepRow step={step} />
          {drivers.isPending ? (
            <Skeleton className="h-40 w-full" />
          ) : drivers.isError ? (
            <ErrorState error={drivers.error} onRetry={() => void drivers.refetch()} />
          ) : step === 1 ? (
            <ChooseStep drivers={drivers.data} value={s.driver} onPick={pickDriver} error={err('driver')} />
          ) : step === 2 && driver ? (
            <CredentialsStep s={s} set={set} driver={driver} err={err} onChange={() => setStep(1)} />
          ) : step === 3 && driver ? (
            <RouteStep s={s} set={set} driver={driver} err={err} />
          ) : step === 4 && draft ? (
            <div className="flex flex-col gap-4">
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <PhoneField value={phone} onChange={setPhone} error={phoneError} hint="Type the phone that should get the test. Limited to 10 an hour." />
                </div>
                <Button variant="secondary" className="mb-6" loading={runTest.isPending} onClick={sendTest}>
                  Send test
                </Button>
              </div>
              {runTest.isPending && <InlineAlert tone="info">Sending a test through {draft.provider.name}…</InlineAlert>}
              {runTest.isError && <MutationError error={runTest.error} />}
              {test && (
                <ProviderTestResultCard
                  result={test}
                  providerName={draft.provider.name}
                  onCheckCredentials={() => setStep(2)}
                  onRetry={sendTest}
                />
              )}
              <div className="flex flex-col gap-2 rounded-lg border border-border-default px-4 py-3">
                <p className="text-body font-medium text-text-primary">When you activate</p>
                <ul className="flex list-disc flex-col gap-1 pl-5 text-caption text-text-secondary marker:text-brand-600">
                  {s.role === 'primary' ? (
                    <>
                      <li>Sign-in codes and every platform SMS start going through {draft.provider.name} right away.</li>
                      <li>Queued platform SMS go out on their next try (they wait up to 30 minutes, codes 5 minutes).</li>
                      {overview?.primary && <li>{overview.primary.name} can stay on as the failover.</li>}
                      {draft.provider.promotional_sender_status === 'pending' && <li>Promotional SMS stay paused until the promotional mask is approved.</li>}
                    </>
                  ) : (
                    <>
                      <li>{draft.provider.name} takes over when the primary fails {s.failAfter} times in a row or one send takes over {s.timeout} s.</li>
                      <li>Traffic goes back to the primary after 5 minutes without errors.</li>
                    </>
                  )}
                </ul>
              </div>
              {s.role === 'primary' && (
                <InlineAlert tone="warning">Activate asks you to type the provider name to confirm.</InlineAlert>
              )}
              {!passed && !test && <p className="text-caption text-text-muted">Send a passing test before you activate.</p>}
              <MutationError error={activateFailover.error} />
            </div>
          ) : null}
          {step === 3 && <MutationError error={saveDraft.error} />}
        </div>
      </Drawer>
      {activating && draft && (
        <ActivatePrimaryDialog
          provider={draft.provider}
          overview={overview}
          onClose={() => setActivating(false)}
          onDone={onClose}
        />
      )}
    </>
  );
}

function StepRow({ step }: { step: Step }) {
  return (
    <ol aria-label="Steps" className="flex items-center gap-2 overflow-x-auto">
      {STEP_LABELS.map((label, i) => {
        const n = (i + 1) as Step;
        const done = n < step;
        const current = n === step;
        return (
          <li key={label} aria-current={current ? 'step' : undefined} className="flex shrink-0 items-center gap-2">
            {i > 0 && <span aria-hidden className={cn('h-px w-5 sm:w-8', done || current ? 'bg-text-secondary' : 'bg-border-default')} />}
            <span
              className={cn(
                'flex size-5 items-center justify-center rounded-full text-caption font-medium',
                done && 'bg-success-bg text-success',
                current && 'bg-brand-600 text-text-inverse',
                !done && !current && 'bg-surface-subtle text-text-muted',
              )}
            >
              {done ? <Check aria-hidden className="size-3" strokeWidth={3} /> : n}
            </span>
            <span className={cn('text-caption', current ? 'font-medium text-text-primary' : 'text-text-secondary')}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Feature({ on, label }: { on: boolean; label: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1', on ? 'text-text-secondary' : 'text-text-muted')}>
      {on ? <Check aria-hidden className="size-3 text-success" /> : <Minus aria-hidden className="size-3" />}
      {on ? label : `No ${label}`}
    </span>
  );
}

function ChooseStep({ drivers, value, onPick, error }: { drivers: SmsProviderDriverInfo[]; value: SmsProviderDriverCode | null; onPick: (d: SmsProviderDriverInfo) => void; error?: string }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-caption text-text-muted">Prices are list rates per SMS part — check your contract.</p>
      <div role="radiogroup" aria-label="SMS provider" className="flex flex-col gap-2">
        {drivers.map((d) => {
          const checked = value === d.code;
          const soon = d.status !== 'available';
          return (
            <label
              key={d.code}
              className={cn(
                'flex items-start gap-3 rounded-lg border px-4 py-3',
                checked ? 'border-brand-600 bg-brand-50' : d.code === 'http' ? 'border-dashed border-border-strong' : 'border-border-default',
                soon ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
              )}
            >
              <input type="radio" name="sms-driver" className="mt-1 size-4 shrink-0 accent-brand-600" checked={checked} disabled={soon} onChange={() => onPick(d)} />
              <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-subtle text-caption font-medium text-brand-600">
                {d.code === 'http' ? '{ }' : providerInitials(d.name)}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="text-body font-semibold text-text-primary">{d.name}</span>
                  {d.btrc_approved && (
                    <Badge size="sm" tone="success">
                      BTRC-approved
                    </Badge>
                  )}
                  {d.recommended && (
                    <Badge size="sm" tone="brand">
                      Recommended
                    </Badge>
                  )}
                  {soon && (
                    <Badge size="sm" tone="neutral">
                      Coming soon
                    </Badge>
                  )}
                </span>
                {d.code === 'http' ? (
                  <span className="text-caption text-text-secondary">Any aggregator with an HTTPS API · price you enter · you map the fields</span>
                ) : (
                  <span className="text-caption text-text-secondary">
                    {d.price_masking_paisa !== null ? `${perPart(d.price_masking_paisa)} / part masking` : ''}
                    {d.price_masking_paisa !== null && d.price_non_masking_paisa !== null ? ' · ' : ''}
                    {d.price_non_masking_paisa !== null ? `${perPart(d.price_non_masking_paisa)} non-masking` : ''}
                  </span>
                )}
                {d.code !== 'http' && (
                  <span className="flex flex-wrap gap-x-3 text-caption">
                    <Feature on={d.features.masking} label="Masking" />
                    <Feature on={d.features.unicode} label="Unicode" />
                    <Feature on={d.features.balance} label="Balance" />
                  </span>
                )}
                {soon && <span className="text-caption text-text-muted">Use “Other (HTTP API)” for it meanwhile.</span>}
              </span>
            </label>
          );
        })}
      </div>
      {error && (
        <p role="alert" className="text-caption text-danger">
          {error}
        </p>
      )}
      <InlineAlert tone="info">Delivery reports aren’t available yet. The log shows “accepted by gateway”, not “delivered”.</InlineAlert>
    </div>
  );
}

function CredentialsStep({
  s,
  set,
  driver,
  err,
  onChange,
}: {
  s: ConfigureState;
  set: (p: Partial<ConfigureState>) => void;
  driver: SmsProviderDriverInfo;
  err: (k: string) => string | undefined;
  onChange: () => void;
}) {
  const isHttp = driver.code === 'http';
  const field = (key: string) => driver.settings_fields.find((f) => f.key === key);
  const accountField = field('account_id');
  const httpSet = (patch: Partial<ConfigureState['http']>) => set({ http: { ...s.http, ...patch } });
  const rowSet = (i: number, patch: Partial<HttpCredRow>) => set({ httpCreds: s.httpCreds.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 rounded-lg border border-border-default bg-surface-subtle px-4 py-3">
        <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-card text-caption font-medium text-brand-600">
          {isHttp ? '{ }' : providerInitials(driver.name)}
        </span>
        <span className="min-w-0 flex-1 text-body font-semibold text-text-primary">{driver.name}</span>
        <Button size="sm" variant="ghost" onClick={onChange}>
          Change
        </Button>
      </div>
      <InlineAlert tone="info">Keys and secrets are write-only: stored encrypted and never shown again — only the last 4 characters.</InlineAlert>
      <Input label="Provider name" value={s.name} onChange={(e) => set({ name: e.target.value })} error={err('name')} hint="Shown in Platform admin. You type it to activate or remove the provider." />
      {isHttp ? (
        <div className="flex flex-col gap-3">
          <p className="text-body font-medium text-text-primary">Credentials</p>
          {s.httpCreds.map((r, i) => (
            <fieldset key={i} className="flex flex-col gap-2 rounded-lg border border-border-default p-3">
              <legend className="px-1 text-caption text-text-muted">Credential {i + 1}</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                <Input label="Field name" value={r.key} onChange={(e) => rowSet(i, { key: e.target.value })} error={err(`httpKey${i}`)} />
                <Input label="Request parameter" value={r.param} onChange={(e) => rowSet(i, { param: e.target.value })} error={err(`httpParam${i}`)} />
              </div>
              <SecretField label="Value" value={r.value} onChange={(v) => rowSet(i, { value: v })} error={err(`httpValue${i}`)} placeholder="Paste from the provider portal" />
              {s.httpCreds.length > 1 && (
                <Button size="sm" variant="ghost" className="self-start" leftIcon={<Trash2 aria-hidden className="size-3.5" />} onClick={() => set({ httpCreds: s.httpCreds.filter((_, j) => j !== i) })}>
                  Remove field
                </Button>
              )}
            </fieldset>
          ))}
          {s.httpCreds.length < 5 && (
            <Button size="sm" variant="secondary" className="self-start" leftIcon={<Plus aria-hidden className="size-3.5" />} onClick={() => set({ httpCreds: [...s.httpCreds, { key: '', value: '', param: '' }] })}>
              Add credential field
            </Button>
          )}
          {err('httpCreds') && <p className="text-caption text-danger">{err('httpCreds')}</p>}
        </div>
      ) : (
        driver.credential_fields.map((f) => (
          <SecretField
            key={f.key}
            label={f.label}
            value={s.credentials[f.key] ?? ''}
            onChange={(v) => set({ credentials: { ...s.credentials, [f.key]: v } })}
            placeholder="Paste from the provider portal"
            hint={f.hint ?? 'Write-only · stored encrypted'}
            error={err(f.key)}
          />
        ))
      )}
      {(accountField || isHttp) && (
        <Input
          label={accountField?.label ?? 'Account ID'}
          value={s.accountId}
          onChange={(e) => set({ accountId: e.target.value })}
          hint={accountField?.hint ?? 'Optional'}
          error={err('account_id')}
        />
      )}
      <Input
        label={field('base_url')?.label ?? 'API endpoint'}
        value={s.baseUrl}
        inputMode="url"
        onChange={(e) => set({ baseUrl: e.target.value })}
        hint={field('base_url')?.hint ?? 'HTTPS only — http:// URLs are rejected'}
        error={err('base_url') ?? (s.baseUrl && !isHttpsUrl(s.baseUrl) ? 'Use an https:// address.' : undefined)}
      />
      {isHttp && (
        <div className="flex flex-col gap-3">
          <p className="text-body font-medium text-text-primary">Request mapping</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Select label="Method" value={s.http.method} onChange={(e) => httpSet({ method: e.target.value as SmsHttpMapping['method'] })}>
              <option value="POST">POST</option>
              <option value="GET">GET</option>
            </Select>
            <Select label="Body format" value={s.http.body_format} onChange={(e) => httpSet({ body_format: e.target.value as SmsHttpMapping['body_format'] })}>
              <option value="json">JSON</option>
              <option value="form">Form</option>
              <option value="query">Query string</option>
            </Select>
            <Input label="Phone parameter" value={s.http.to_param} onChange={(e) => httpSet({ to_param: e.target.value })} error={err('to_param')} />
            <Input label="Text parameter" value={s.http.text_param} onChange={(e) => httpSet({ text_param: e.target.value })} error={err('text_param')} />
            <Input label="Sender parameter" value={s.http.sender_param} onChange={(e) => httpSet({ sender_param: e.target.value })} error={err('sender_param')} />
            <Input label="Message ID path" value={s.http.message_id_path ?? ''} onChange={(e) => httpSet({ message_id_path: e.target.value })} hint="Optional, e.g. data.id" />
            <Input label="Success path" value={s.http.success_path} onChange={(e) => httpSet({ success_path: e.target.value })} error={err('success_path')} hint="Dot path in the JSON reply" />
            <Input label="Success value" value={s.http.success_value} onChange={(e) => httpSet({ success_value: e.target.value })} error={err('success_value')} />
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children, hint, error }: { label: ReactNode; children: ReactNode; hint?: ReactNode; error?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-body font-medium text-text-primary">{label}</span>
      {children}
      {error ? <p className="text-caption text-danger">{error}</p> : hint ? <p className="text-caption text-text-muted">{hint}</p> : null}
    </div>
  );
}

export function RouteFields({
  role,
  groups,
  onGroups,
  defaultSender,
  onDefaultSender,
  promoSender,
  onPromoSender,
  promoStatus,
  onPromoStatus,
  rateLimit,
  onRateLimit,
  failAfter,
  onFailAfter,
  timeout,
  onTimeout,
  err,
}: {
  role: 'primary' | 'failover' | 'draft' | 'inactive' | 'removed';
  groups: SmsMessageGroup[];
  onGroups: (g: SmsMessageGroup[]) => void;
  defaultSender: string;
  onDefaultSender: (v: string) => void;
  promoSender: string;
  onPromoSender: (v: string) => void;
  promoStatus: '' | 'approved' | 'pending';
  onPromoStatus: (v: '' | 'approved' | 'pending') => void;
  rateLimit: string;
  onRateLimit: (v: string) => void;
  failAfter: string;
  onFailAfter: (v: string) => void;
  timeout: string;
  onTimeout: (v: string) => void;
  err: (k: string) => string | undefined;
}) {
  const primary = role === 'primary';
  return (
    <>
      <Field label="Message types it sends" hint={primary ? 'The primary always sends shop, registration, billing and sign-in SMS.' : 'Untick a type to keep it on the other provider.'} error={err('groups')}>
        <div className="flex flex-col divide-y divide-border-default rounded-lg border border-border-default">
          {SMS_MESSAGE_GROUPS.map((g) => {
            const locked = primary && SMS_PRIMARY_REQUIRED_GROUPS.includes(g);
            return (
              <div key={g} className="px-3 py-2.5">
                <Checkbox
                  label={SMS_MESSAGE_GROUP_LABELS[g]}
                  checked={groups.includes(g)}
                  disabled={locked}
                  onChange={(e) => onGroups(e.target.checked ? [...groups, g] : groups.filter((x) => x !== g))}
                />
              </div>
            );
          })}
        </div>
      </Field>
      <Input label="Default sender ID" value={defaultSender} onChange={(e) => onDefaultSender(e.target.value)} error={err('defaultSender')} hint="Registration, billing and sign-in messages" />
      <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
        <Input label="Promotional mask" value={promoSender} onChange={(e) => onPromoSender(e.target.value)} error={err('promoSender')} hint="Broadcasts only · leave empty for none" />
        <Select label="BTRC status" value={promoStatus || 'pending'} disabled={!promoSender.trim()} onChange={(e) => onPromoStatus(e.target.value as 'approved' | 'pending')}>
          <option value="pending">Pending BTRC</option>
          <option value="approved">Approved</option>
        </Select>
      </div>
      {promoSender.trim() && promoStatus !== 'approved' && <InlineAlert tone="warning">Promotional SMS stay paused until the mask is approved.</InlineAlert>}
      <Input label="Rate limit" inputMode="numeric" value={rateLimit} onChange={(e) => onRateLimit(e.target.value)} trailing={<span className="text-caption">SMS / minute</span>} error={err('rateLimit')} hint="Only broadcasts wait for it — sign-in codes always go first." />
      {role !== 'primary' && (
        <div className="flex flex-col gap-2 rounded-lg bg-surface-subtle px-3 py-3">
          <p className="text-caption text-text-muted">When the role is Failover</p>
          <div className="flex flex-wrap items-center gap-2 text-body text-text-primary">
            Switch after
            <input aria-label="Failed sends before switching" inputMode="numeric" value={failAfter} onChange={(e) => onFailAfter(e.target.value)} className={cn('w-14 rounded-md border bg-surface-card px-2 py-1 text-center outline-none focus:shadow-focus', err('failAfter') ? 'border-danger' : 'border-border-default')} />
            failed sends or a
            <input aria-label="Timeout in seconds" inputMode="numeric" value={timeout} onChange={(e) => onTimeout(e.target.value)} className={cn('w-14 rounded-md border bg-surface-card px-2 py-1 text-center outline-none focus:shadow-focus', err('timeout') ? 'border-danger' : 'border-border-default')} />
            s timeout
          </div>
          {(err('failAfter') || err('timeout')) && <p className="text-caption text-danger">Use 1–10 failed sends and a 3–30 s timeout.</p>}
          <p className="text-caption text-text-muted">Traffic goes back to the primary after 5 minutes without errors.</p>
        </div>
      )}
    </>
  );
}

function RouteStep({ s, set, driver, err }: { s: ConfigureState; set: (p: Partial<ConfigureState>) => void; driver: SmsProviderDriverInfo; err: (k: string) => string | undefined }) {
  const setRole = (role: 'primary' | 'failover') =>
    set({ role, groups: role === 'primary' ? [...new Set([...SMS_PRIMARY_REQUIRED_GROUPS, ...s.groups])] : s.groups });
  return (
    <div className="flex flex-col gap-4">
      <Field label="Role">
        <div role="radiogroup" aria-label="Role" className="grid gap-2 sm:grid-cols-2">
          {(
            [
              ['primary', 'Primary', 'Sends everything by default'],
              ['failover', 'Failover', 'Takes over when the primary fails'],
            ] as const
          ).map(([value, title, detail]) => (
            <label key={value} className={cn('flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5', s.role === value ? 'border-brand-600 bg-brand-50' : 'border-border-default')}>
              <input type="radio" name="sms-role" className="mt-0.5 size-4 accent-brand-600" checked={s.role === value} onChange={() => setRole(value)} />
              <span className="flex flex-col">
                <span className="text-body font-medium text-text-primary">{title}</span>
                <span className="text-caption text-text-secondary">{detail}</span>
              </span>
            </label>
          ))}
        </div>
      </Field>
      <RouteFields
        role={s.role}
        groups={s.groups}
        onGroups={(groups) => set({ groups })}
        defaultSender={s.defaultSender}
        onDefaultSender={(defaultSender) => set({ defaultSender })}
        promoSender={s.promoSender}
        onPromoSender={(promoSender) => set({ promoSender })}
        promoStatus={s.promoStatus}
        onPromoStatus={(promoStatus) => set({ promoStatus })}
        rateLimit={s.rateLimit}
        onRateLimit={(rateLimit) => set({ rateLimit })}
        failAfter={s.failAfter}
        onFailAfter={(failAfter) => set({ failAfter })}
        timeout={s.timeout}
        onTimeout={(timeout) => set({ timeout })}
        err={err}
      />
      <Input
        label="Price per SMS part (masking)"
        leading="৳"
        value={s.priceMasking}
        inputMode="decimal"
        onChange={(e) => set({ priceMasking: e.target.value })}
        error={err('priceMasking')}
        hint={driver.price_masking_paisa !== null ? `List price ${perPart(driver.price_masking_paisa)}. Used for cost estimates only.` : 'Used for cost estimates only.'}
      />
      <p className="flex items-center gap-1.5 text-caption text-text-muted">
        <Info aria-hidden className="size-3.5" /> Next saves a draft. Nothing is sent through it until you activate it.
      </p>
    </div>
  );
}

