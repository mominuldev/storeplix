import { isApiError } from '@storeplix/api-client';
import {
  SMS_PRIMARY_REQUIRED_GROUPS,
  SMS_SENDER_ID_PATTERN,
  type SmsMessageGroup,
  type SmsProvider,
  type SmsProviderDriverInfo,
  type SmsProviderOverview,
  type UpdateSmsProviderInput,
} from '@storeplix/types';
import { Badge, Button, Drawer, formatBdt, Input, moneyToInput, parseMoney, SecretField, Skeleton, Toggle } from '@storeplix/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useState } from 'react';
import { LoggedAs } from '../../components/LoggedAs';
import { ErrorState } from '../../components/States';
import { api } from '../../lib/api';
import { formatDate, formatDateTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { RouteFields } from './ConfigureDrawer';
import { ActivatePrimaryDialog, MutationError, ProviderTestResultCard, RemoveProviderDialog } from './dialogs';
import { healthMeta, isHttpsUrl, normalizeBdPhone, providerInitials, roleMeta, testPhoneMemory } from './format';
import { platformSmsKeys, smsErrorText, useDrivers } from './queries';
import { InlineAlert, LockedField, PhoneField, ReadOnlyField, SubHeader, TestSmsDialog } from './ui';

// Manage provider drawer (PHASE-8-9B §11.3, Figma 2114:10202 / drawer 2114:10458): header name + Active/role pills,
// "Connected since … · last test …"; Credentials (locked, last 4) with Rotate → rotate state (paste new values +
// test phone → "Test and save new key"; a failing test keeps the old key, P89B-5); account ID / endpoint read-only
// for active providers (they change in rotate); Route & senders, rate limit, failover rules, alerts → Save changes
// (`revision`, 409 → reload); last test + Send test SMS; failover / draft / inactive add Remove provider.
export function ManageDrawer({
  providerId,
  startRotate = false,
  overview,
  onClose,
}: {
  providerId: string;
  startRotate?: boolean;
  overview: SmsProviderOverview | undefined;
  onClose: () => void;
}) {
  const query = useQuery({ queryKey: [...platformSmsKeys.root, 'provider', providerId], queryFn: () => api.admin.platformSms.providers.get(providerId) });
  const drivers = useDrivers();
  const p = query.data;
  const driver = drivers.data?.find((d) => d.code === p?.driver);
  return (
    <Drawer
      open
      onClose={onClose}
      width={520}
      title={
        p ? (
          <span className="flex flex-wrap items-center gap-2">
            <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-brand-50 text-caption font-medium text-brand-600">
              {providerInitials(p.name)}
            </span>
            {p.name}
            <Badge size="sm" tone={roleMeta[p.role].tone}>
              {roleMeta[p.role].label}
            </Badge>
          </span>
        ) : (
          'Manage provider'
        )
      }
      description={
        p
          ? [p.activated_at ? `Connected since ${formatDate(p.activated_at)}` : 'Not activated', p.last_test ? `last test ${formatDateTime(p.last_test.at)} ${p.last_test.status}` : 'never tested'].join(' · ')
          : undefined
      }
    >
      {query.isPending ? (
        <div className="p-5">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : query.isError ? (
        <div className="p-5">
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        </div>
      ) : (
        <ManageBody key={`${p!.id}:${p!.revision}`} provider={p!} driver={driver} overview={overview} startRotate={startRotate} onClose={onClose} onReload={() => void query.refetch()} />
      )}
    </Drawer>
  );
}

function ManageBody({
  provider: p,
  driver,
  overview,
  startRotate,
  onClose,
  onReload,
}: {
  provider: SmsProvider;
  driver: SmsProviderDriverInfo | undefined;
  overview: SmsProviderOverview | undefined;
  startRotate: boolean;
  onClose: () => void;
  onReload: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const active = p.role === 'primary' || p.role === 'failover';
  const credentialKeys = driver && driver.code !== 'http' ? driver.credential_fields.map((f) => ({ key: f.key, label: f.label })) : Object.keys(p.credentials_hint).map((k) => ({ key: k, label: k }));

  const [rotating, setRotating] = useState(startRotate);
  const [newCreds, setNewCreds] = useState<Record<string, string>>({});
  const [rotAccount, setRotAccount] = useState(p.settings.account_id ?? '');
  const [rotBase, setRotBase] = useState(p.settings.base_url);
  const [rotPhone, setRotPhone] = useState(testPhoneMemory.get());
  const [rotError, setRotError] = useState<string | null>(null);

  const [groups, setGroups] = useState<SmsMessageGroup[]>(p.message_groups);
  const [defaultSender, setDefaultSender] = useState(p.default_sender_id);
  const [promoSender, setPromoSender] = useState(p.promotional_sender_id ?? '');
  const [promoStatus, setPromoStatus] = useState<'' | 'approved' | 'pending'>(p.promotional_sender_status ?? '');
  const [rateLimit, setRateLimit] = useState(String(p.rate_limit_per_minute));
  const [failAfter, setFailAfter] = useState(String(p.failover_after_failures));
  const [timeout, setTimeoutS] = useState(String(p.failover_timeout_seconds));
  const [price, setPrice] = useState(moneyToInput(p.price_masking_paisa));
  const [threshold, setThreshold] = useState(moneyToInput(p.balance.low_threshold_paisa));
  const [alertEmail, setAlertEmail] = useState(p.balance.alert_email);
  const [alertInApp, setAlertInApp] = useState(p.balance.alert_in_app);
  const [account, setAccount] = useState(p.settings.account_id ?? '');
  const [base, setBase] = useState(p.settings.base_url);
  const [showErrors, setShowErrors] = useState(false);
  const [testing, setTesting] = useState(false);
  const [dialog, setDialog] = useState<'remove' | 'activate' | null>(null);

  const errors: Record<string, string> = {};
  if (!groups.length) errors.groups = 'Pick at least one message type.';
  if (p.role === 'primary' && SMS_PRIMARY_REQUIRED_GROUPS.some((g) => !groups.includes(g))) errors.groups = 'The primary must send shop, registration, billing and sign-in SMS.';
  if (!SMS_SENDER_ID_PATTERN.test(defaultSender.trim())) errors.defaultSender = '3–11 letters and numbers.';
  if (promoSender.trim() && !SMS_SENDER_ID_PATTERN.test(promoSender.trim())) errors.promoSender = '3–11 letters and numbers.';
  const rate = Number(rateLimit);
  if (!Number.isInteger(rate) || rate < 1 || rate > 6000) errors.rateLimit = 'Between 1 and 6,000 per minute.';
  if (!(Number(failAfter) >= 1 && Number(failAfter) <= 10)) errors.failAfter = '1–10';
  if (!(Number(timeout) >= 3 && Number(timeout) <= 30)) errors.timeout = '3–30';
  const priceP = parseMoney(price);
  if (priceP !== null && Number.isNaN(priceP)) errors.price = 'Enter an amount like 0.40.';
  const thresholdP = parseMoney(threshold);
  if (thresholdP !== null && Number.isNaN(thresholdP)) errors.threshold = 'Enter an amount in taka.';
  if (!active && !isHttpsUrl(base)) errors.base = 'Use an https:// address.';
  const err = (k: string) => (showErrors ? errors[k] : undefined);

  const invalidate = () => qc.invalidateQueries({ queryKey: platformSmsKeys.root });

  const save = useMutation({
    mutationFn: () => {
      const input: UpdateSmsProviderInput = {
        revision: p.revision,
        default_sender_id: defaultSender.trim(),
        promotional_sender_id: promoSender.trim() || null,
        promotional_sender_status: promoSender.trim() ? promoStatus || 'pending' : null,
        message_groups: groups,
        rate_limit_per_minute: rate,
        failover_after_failures: Number(failAfter),
        failover_timeout_seconds: Number(timeout),
        price_masking_paisa: priceP === null || Number.isNaN(priceP) ? null : priceP,
        low_threshold_paisa: thresholdP === null || Number.isNaN(thresholdP) ? null : thresholdP,
        alert_email: alertEmail,
        alert_in_app: alertInApp,
      };
      if (!active) input.settings = { account_id: account.trim() || null, base_url: base.trim() };
      return api.admin.platformSms.providers.update(p.id, input);
    },
    onSuccess: (next) => {
      void invalidate();
      qc.setQueryData([...platformSmsKeys.root, 'provider', p.id], next);
      toast(`${p.name} saved`);
    },
  });

  const rotate = useMutation({
    mutationFn: (phone: string) =>
      api.admin.platformSms.providers.rotate(p.id, {
        credentials: Object.fromEntries(Object.entries(newCreds).filter(([, v]) => v.trim() !== '')),
        settings: { account_id: rotAccount.trim() || null, base_url: rotBase.trim() },
        phone,
      }),
    onSuccess: (next) => {
      void invalidate();
      qc.setQueryData([...platformSmsKeys.root, 'provider', p.id], next);
      toast('New key tested and saved · the old one no longer works');
      setRotating(false);
    },
  });

  const activateFailover = useMutation({
    mutationFn: () => api.admin.platformSms.providers.activate(p.id, { role: 'failover' }),
    onSuccess: (next) => {
      qc.setQueryData(platformSmsKeys.overview, next);
      void invalidate();
      toast(`${p.name} is now the failover provider`);
      onClose();
    },
  });

  const submitRotate = () => {
    const phone = normalizeBdPhone(rotPhone);
    const missing = credentialKeys.some((f) => !newCreds[f.key]?.trim());
    if (missing) return setRotError('Paste every new credential value.');
    if (!isHttpsUrl(rotBase)) return setRotError('Use an https:// address for the endpoint.');
    if (!phone) return setRotError('Enter a Bangladesh mobile number for the test SMS.');
    setRotError(null);
    testPhoneMemory.set(rotPhone);
    rotate.mutate(phone);
  };

  const conflict = isApiError(save.error) && save.error.code === 'revision_conflict';
  const health = healthMeta[p.health];

  return (
    <>
      <div className="flex flex-col gap-5 px-4 py-4 sm:px-5">
        {active && (
          <div className="flex flex-wrap gap-2">
            <Badge size="sm" tone={health.tone}>
              {health.label}
            </Badge>
            {p.accepted_rate_24h !== null && <span className="text-caption text-text-muted">{p.accepted_rate_24h}% accepted by gateway (24 h)</span>}
          </div>
        )}

        <section className="flex flex-col gap-3">
          <SubHeader title="Credentials" description="Write-only. Rotate pastes a new value; the old one keeps working until the new one passes a test." />
          {!rotating ? (
            <>
              {credentialKeys.map((f) => (
                <LockedField
                  key={f.key}
                  label={f.label}
                  hint={p.credentials_hint[f.key]}
                  action={
                    p.role !== 'removed' && (
                      <Button size="sm" variant="ghost" onClick={() => setRotating(true)}>
                        Rotate
                      </Button>
                    )
                  }
                />
              ))}
              <p className="text-caption text-text-muted">
                {p.credentials_rotated_at
                  ? `Last rotated ${formatDate(p.credentials_rotated_at)}${p.credentials_rotated_by ? ` by ${p.credentials_rotated_by.name}` : ''}`
                  : `Added ${formatDate(p.created_at)}`}
              </p>
            </>
          ) : (
            <div className="flex flex-col gap-3 rounded-lg border border-brand-600 p-3" data-testid="rotate-form">
              {credentialKeys.map((f) => (
                <SecretField
                  key={f.key}
                  label={`${f.label} — new value`}
                  value={newCreds[f.key] ?? ''}
                  onChange={(v) => setNewCreds((c) => ({ ...c, [f.key]: v }))}
                  placeholder="Paste the new value from the provider portal"
                  hint={p.credentials_hint[f.key] ? `Current ${p.credentials_hint[f.key]} stays active until the test passes.` : undefined}
                />
              ))}
              <div className="grid gap-3 sm:grid-cols-2">
                <Input label="Account ID" value={rotAccount} onChange={(e) => setRotAccount(e.target.value)} />
                <Input label="API endpoint" value={rotBase} onChange={(e) => setRotBase(e.target.value)} error={rotBase && !isHttpsUrl(rotBase) ? 'Use an https:// address.' : undefined} />
              </div>
              <PhoneField value={rotPhone} onChange={setRotPhone} label="Send the test SMS to" />
              {rotError && <p role="alert" className="text-caption text-danger">{rotError}</p>}
              {rotate.isError && <InlineAlert tone="danger">{smsErrorText(rotate.error)}</InlineAlert>}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" loading={rotate.isPending} onClick={submitRotate}>
                  Test and save new key
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setRotating(false);
                    setNewCreds({});
                    rotate.reset();
                    setRotError(null);
                  }}
                >
                  Cancel rotate
                </Button>
              </div>
            </div>
          )}
          {active ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <ReadOnlyField label="Account ID" value={p.settings.account_id} />
              <ReadOnlyField label="API endpoint" value={p.settings.base_url} caption="Changed by rotating" />
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="Account ID" value={account} onChange={(e) => setAccount(e.target.value)} />
              <Input label="API endpoint" value={base} onChange={(e) => setBase(e.target.value)} error={err('base')} />
            </div>
          )}
        </section>

        <div aria-hidden className="h-px bg-border-default" />

        <section className="flex flex-col gap-4">
          <SubHeader title="Route & senders" description={active ? 'To change the role, make another provider primary.' : 'Saved on the draft; activate it when the test passes.'} />
          <RouteFields
            role={p.role}
            groups={groups}
            onGroups={setGroups}
            defaultSender={defaultSender}
            onDefaultSender={setDefaultSender}
            promoSender={promoSender}
            onPromoSender={setPromoSender}
            promoStatus={promoStatus}
            onPromoStatus={setPromoStatus}
            rateLimit={rateLimit}
            onRateLimit={setRateLimit}
            failAfter={failAfter}
            onFailAfter={setFailAfter}
            timeout={timeout}
            onTimeout={setTimeoutS}
            err={err}
          />
          <Input label="Price per SMS part (masking)" leading="৳" value={price} onChange={(e) => setPrice(e.target.value)} error={err('price')} hint="Used for cost estimates only." />
        </section>

        <div aria-hidden className="h-px bg-border-default" />

        <section className="flex flex-col gap-3">
          <SubHeader title="Balance alerts" description={p.balance.status === 'unsupported' ? 'This provider doesn’t report a balance.' : `Balance ${formatBdt(p.balance.amount_paisa)} · checked every 15 minutes`} />
          <Input label="Alert me when the balance is below" leading="৳" value={threshold} onChange={(e) => setThreshold(e.target.value)} error={err('threshold')} />
          <div className="flex items-center justify-between gap-3 text-body text-text-primary">
            Email super admins
            <Toggle label="Email super admins" checked={alertEmail} onChange={setAlertEmail} />
          </div>
          <div className="flex items-center justify-between gap-3 text-body text-text-primary">
            Show a banner in Platform admin
            <Toggle label="Show a banner in Platform admin" checked={alertInApp} onChange={setAlertInApp} />
          </div>
        </section>

        <div aria-hidden className="h-px bg-border-default" />

        <section className="flex flex-col gap-3">
          {p.last_test ? (
            <InlineAlert
              tone={p.last_test.status === 'passed' ? 'success' : 'danger'}
              action={
                <Button size="sm" variant="secondary" onClick={() => setTesting(true)}>
                  Send test SMS
                </Button>
              }
            >
              Last test {p.last_test.status} · {formatDateTime(p.last_test.at)}
              {p.last_test.by ? ` by ${p.last_test.by.name}` : ''}
              {p.test_required ? ' · the connection changed since — test again before activating' : ''}
            </InlineAlert>
          ) : (
            <InlineAlert
              tone="info"
              action={
                <Button size="sm" variant="secondary" onClick={() => setTesting(true)}>
                  Send test SMS
                </Button>
              }
            >
              Never tested.
            </InlineAlert>
          )}
          {!active && p.role !== 'removed' && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={p.test_required || p.last_test?.status !== 'passed'} onClick={() => setDialog('activate')}>
                Activate as primary
              </Button>
              <Button size="sm" variant="secondary" disabled={p.test_required || p.last_test?.status !== 'passed'} loading={activateFailover.isPending} onClick={() => activateFailover.mutate()}>
                Activate as failover
              </Button>
            </div>
          )}
          <MutationError error={activateFailover.error} />
          {p.role !== 'primary' && p.role !== 'removed' && (
            <Button variant="ghost" className="self-start text-danger hover:bg-danger-bg" onClick={() => setDialog('remove')}>
              Remove provider
            </Button>
          )}
        </section>

        {conflict ? (
          <InlineAlert
            tone="warning"
            action={
              <Button size="sm" variant="secondary" onClick={onReload}>
                Reload
              </Button>
            }
          >
            Someone else changed this provider. Reload to see the latest settings.
          </InlineAlert>
        ) : (
          <MutationError error={save.error} />
        )}
      </div>
      <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-border-default bg-surface-card px-4 py-3">
        <span className="flex-1">
          <LoggedAs />
        </span>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          loading={save.isPending}
          disabled={p.role === 'removed' || conflict}
          leftIcon={save.isSuccess ? <Check aria-hidden className="size-4" /> : undefined}
          onClick={() => {
            if (Object.keys(errors).length) {
              setShowErrors(true);
              return;
            }
            save.mutate();
          }}
        >
          Save changes
        </Button>
      </div>
      {testing && (
        <TestSmsDialog
          title={`Send a test SMS through ${p.name}`}
          description="Fixed text “Store Plix SMS test from … No action needed.”"
          onClose={() => {
            setTesting(false);
            void invalidate();
          }}
          send={(phone) => api.admin.platformSms.providers.test(p.id, { phone })}
          renderResult={(r) => <ProviderTestResultCard result={r} providerName={p.name} />}
        />
      )}
      {dialog === 'remove' && <RemoveProviderDialog provider={p} onClose={() => setDialog(null)} onDone={onClose} />}
      {dialog === 'activate' && <ActivatePrimaryDialog provider={p} overview={overview} onClose={() => setDialog(null)} onDone={onClose} />}
    </>
  );
}
