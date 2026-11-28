import { isApiError } from '@storeplix/api-client';
import type { IntegrationSettingsMap, PurchaseTrigger, StoreIntegration, TrackingEventName, TrackingTestMode, TrackingTestResult } from '@storeplix/types';
import { Badge, Button, buttonVariants, Input, Select, Skeleton, Toggle } from '@storeplix/ui';
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, StateCard } from '../catalog/states';
import { useCountdown, useReadOnly } from '../impersonation/hooks';
import { toast } from '../online-store/components/Toast';
import {
  Banner,
  Breadcrumb,
  Columns,
  connectedMeta,
  ConnectionCheckCard,
  CopyRow,
  DetailTabs,
  DisconnectDialog,
  IntegrationHeader,
  Panel,
  ReadOnlyField,
  SettingRow,
  TableCard,
  TableHead,
  tdClass,
  Tip,
  WriteOnlySecret,
} from './components';
import {
  attentionText,
  errorField,
  eventWhen,
  idProblem,
  integrationErrorText,
  isLive,
  normalizeId,
  PIXEL_TAB_LABELS,
  PIXEL_TABS,
  pixelTabFromParam,
  PROVIDER_META,
  providerEventName,
  providerEvents,
  purchaseTriggerLabel,
  secretProblem,
  sentFrom,
  testCodeProblem,
  type PixelProvider,
  type PixelTab,
} from './integrations';
import { useIntegration, useSaveIntegration, useSendTestEvent, useStartTestMode, useTrackingStats, useUpdateSettings } from './queries';
import { EventLog, EventStatsTable, StatsCard, TotalsCard } from './tracking';

// PHASE-8-9D §8 pixel pages: Meta Pixel + CAPI `/integrations/meta-pixel`, GA4 `/integrations/ga4`, TikTok
// `/integrations/tiktok`. Not connected → the three-step connect flow (TikTok 2133:53731). Connected → tabs Overview ·
// Event log · Test & verify (§8, Q365: the Settings content of 2139:57369 is folded into Overview; GA4 2132:53511,
// TikTok 2140:58094, Meta 2139:56806 / 2134:64916). `?tab=settings` and `?tab=test-events` deep links still work.
// Rule 7: only IDs and tokens; pasted code is refused client-side and by the API (422 `integration_code_pasted`).

type PixelSettings = IntegrationSettingsMap[PixelProvider];

const ID_KEY: Record<PixelProvider, 'pixel_id' | 'measurement_id'> = { meta_pixel: 'pixel_id', ga4: 'measurement_id', tiktok_pixel: 'pixel_id' };
const SECRET: Record<PixelProvider, { key: 'access_token' | 'api_secret'; label: string; where: string }> = {
  meta_pixel: { key: 'access_token', label: 'Conversions API access token', where: 'Events Manager → your pixel → Settings → Conversions API → Generate access token.' },
  ga4: { key: 'api_secret', label: 'Measurement Protocol API secret', where: 'Admin → Data streams → your web stream → Measurement Protocol API secrets → Create.' },
  tiktok_pixel: { key: 'access_token', label: 'Events API access token', where: 'In the same Settings page → Events API → Generate access token.' },
};
const ID_WHERE: Record<PixelProvider, string> = {
  meta_pixel: 'From Meta Events Manager → Data sources → your pixel → Settings.',
  ga4: 'From Google Analytics → Admin → Data streams → Web.',
  tiktok_pixel: 'Everything comes from TikTok Ads Manager → Tools → Events → Web events.',
};
const DEDUP: Record<PixelProvider, string> = {
  meta_pixel: 'Browser and server events share one event ID, so Meta counts each order once.',
  ga4: 'Purchases are sent once from our server with the order number as the transaction ID, so GA4 counts each order once.',
  tiktok_pixel: 'Browser and server events share one event_id, so TikTok counts each order once.',
};
const hasTestCode = (p: PixelProvider): p is 'meta_pixel' | 'tiktok_pixel' => p !== 'ga4';

const idOf = (p: PixelProvider, s: PixelSettings | null | undefined): string => (s ? (ID_KEY[p] === 'pixel_id' ? (s as { pixel_id: string }).pixel_id : (s as { measurement_id: string }).measurement_id) : '');
const testCodeOf = (s: PixelSettings | null | undefined): string | null => (s && 'test_event_code' in s ? s.test_event_code : null);

const STOPS = ['Browser pixel on every page of your shop', 'Purchases sent from our server', 'Retries of events still waiting'];

export function PixelPage({ provider }: { provider: PixelProvider }) {
  const scope = useStoreScope();
  const readOnly = useReadOnly();
  const row = useIntegration(provider);
  const [params, setParams] = useSearchParams();
  const tab = pixelTabFromParam(params.get('tab'));
  const [disconnecting, setDisconnecting] = useState(false);
  const sendTest = useSendTestEvent(provider);
  const [testResult, setTestResult] = useState<TrackingTestResult | null>(null);
  const go = (t: PixelTab) => {
    const p = new URLSearchParams(params);
    if (t === 'overview') p.delete('tab');
    else p.set('tab', t);
    setParams(p);
  };

  if (row.isPending) {
    return (
      <div className="flex flex-col gap-5" aria-busy="true" aria-label="Loading integration">
        <Breadcrumb provider={provider} />
        <Skeleton className="h-36 rounded-card" />
        <Skeleton className="h-96 rounded-card" />
      </div>
    );
  }
  if (row.isError) {
    return (
      <div className="flex flex-col gap-5">
        <Breadcrumb provider={provider} />
        <StateCard>
          <ErrorBlock title={`We couldn’t load ${PROVIDER_META[provider].name}`} error={row.error} onRetry={() => void row.refetch()} />
        </StateCard>
      </div>
    );
  }
  const data = row.data;
  const can = data.can;
  const manage = scope.canManageIntegrations && can.manage && !readOnly;
  const live = isLive(data.status);
  const runTest = (event: TrackingEventName = 'purchase') =>
    sendTest.mutate(
      { event },
      {
        onSuccess: (r) => {
          setTestResult(r);
          toast(r.delivered ? 'Test event delivered' : 'The test event wasn’t accepted', r.delivered ? 'success' : 'error');
        },
        onError: (e) => toast(integrationErrorText(e, provider), 'error'),
      },
    );

  return (
    <div className="flex flex-col gap-5">
      <Breadcrumb provider={provider} />
      <IntegrationHeader
        provider={provider}
        status={data.status}
        meta={live ? connectedMeta(data, [{ icon: 'shield', text: `${PROVIDER_META[provider].idLabel}: ${idOf(provider, data.settings)}` }]) : [{ icon: 'shield', text: `Uses your own ${PROVIDER_META[provider].short} account` }, { icon: 'clock', text: 'About 3 minutes' }]}
        primary={
          live && manage && can.send_test ? (
            <Button
              loading={sendTest.isPending}
              onClick={() => {
                go('test');
                runTest();
              }}
            >
              Send test event
            </Button>
          ) : undefined
        }
        onDisconnect={live && manage ? () => setDisconnecting(true) : undefined}
      />
      {!scope.canManageIntegrations && <p className="rounded-md bg-surface-subtle px-3 py-2 text-body text-text-secondary">Only owners and managers can connect or change integrations.</p>}

      {!live ? (
        <ConnectFlow provider={provider} row={data} manage={manage} />
      ) : (
        <>
          <DetailTabs label={`${PROVIDER_META[provider].name} sections`} value={tab} onChange={go} items={PIXEL_TABS.map((t) => ({ value: t, label: PIXEL_TAB_LABELS[t] }))} />
          {data.attention.length > 0 && (
            <div className="flex flex-col gap-2">
              {data.attention.map((a) => (
                <Banner key={a.reason} tone={data.status === 'error' ? 'danger' : 'warning'}>
                  {attentionText(a, provider)}
                </Banner>
              ))}
            </div>
          )}
          {tab === 'overview' && <OverviewTab provider={provider} row={data} manage={manage} />}
          {tab === 'events' && (
            <Columns
              left={<EventLog provider={provider} title="Event log" description={`Every event sent to ${PROVIDER_META[provider].short}. Browser and server copies share one event ID, so they’re counted once.`} />}
              right={
                <>
                  <StatsCard provider={provider} />
                  <Tip title="How deduplication works">Your shop’s browser and our server send the same event with one event ID. The platform keeps the first copy and drops the second, so each order counts once even when cookies are blocked.</Tip>
                </>
              }
            />
          )}
          {tab === 'test' && <TestTab provider={provider} row={data} manage={manage && can.send_test} sending={sendTest.isPending} result={testResult} error={sendTest.error} onSend={runTest} onOverview={() => go('overview')} />}
        </>
      )}

      {disconnecting && <DisconnectDialog provider={provider} stops={STOPS} keepNote="Your pixel and past data stay in your ad account." onClose={() => setDisconnecting(false)} />}
    </div>
  );
}

// ---------- Connect flow (TikTok 2133:53731; used for every pixel) ----------

function StepBadge({ n, done }: { n: number; done: boolean }) {
  return (
    <span aria-hidden className={done ? 'flex size-6 shrink-0 items-center justify-center rounded-full bg-success-bg text-caption font-semibold text-success' : 'flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-600 text-caption font-semibold text-text-inverse'}>
      {done ? '✓' : n}
    </span>
  );
}

function ConnectFlow({ provider, row, manage }: { provider: PixelProvider; row: StoreIntegration<PixelProvider>; manage: boolean }) {
  const meta = PROVIDER_META[provider];
  const secret = SECRET[provider];
  const save = useSaveIntegration(provider);
  const [id, setId] = useState(idOf(provider, row.settings));
  const [token, setToken] = useState('');
  const [code, setCode] = useState(testCodeOf(row.settings) ?? '');
  const [touched, setTouched] = useState({ id: false, token: false, code: false });
  const idErr = touched.id ? idProblem(provider, id) : null;
  const tokenErr = touched.token ? secretProblem(token, secret.label) : null;
  const codeErr = touched.code && hasTestCode(provider) ? testCodeProblem(code) : null;
  const apiField = errorField(save.error);
  const apiMsg = save.error ? integrationErrorText(save.error, provider) : null;
  const tokenApiErr = isApiError(save.error) && save.error.code === 'integration_credentials_invalid' ? apiMsg : apiField === secret.key ? apiMsg : null;
  const idApiErr = apiField === ID_KEY[provider] ? apiMsg : null;
  const codeApiErr = apiField === 'test_event_code' ? apiMsg : null;
  const otherErr = apiMsg && !tokenApiErr && !idApiErr && !codeApiErr ? apiMsg : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched({ id: true, token: true, code: true });
    if (idProblem(provider, id) || secretProblem(token, secret.label) || (hasTestCode(provider) && testCodeProblem(code))) return;
    const settings = { ...row.defaults, [ID_KEY[provider]]: normalizeId(provider, id), ...(hasTestCode(provider) ? { test_event_code: code.trim() || null } : {}) } as PixelSettings;
    save.mutate(
      { settings, credentials: { [secret.key]: token.trim() } as never, ...(row.status !== 'not_connected' ? { revision: row.revision } : {}) },
      { onSuccess: () => toast(`${meta.short} connected`) },
    );
  };

  const steps = hasTestCode(provider) ? 3 : 2;
  return (
    <Columns
      left={
        <>
          <Panel title={`Connect ${meta.short} in ${steps} steps`} description={ID_WHERE[provider]}>
            <form className="flex flex-col gap-5" onSubmit={submit} noValidate aria-label={`Connect ${meta.short}`}>
              <div className="flex gap-3">
                <StepBadge n={1} done={!!id && !idProblem(provider, id)} />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <p className="text-body font-semibold text-text-primary">{meta.idLabel}</p>
                  <Input
                    label={meta.idLabel}
                    value={id}
                    disabled={!manage}
                    onChange={(e) => setId(e.target.value)}
                    onBlur={() => setTouched((t) => ({ ...t, id: true }))}
                    error={idErr ?? idApiErr ?? undefined}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
              </div>
              <div className="flex gap-3">
                <StepBadge n={2} done={!!token && !secretProblem(token, secret.label)} />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <p className="text-body font-semibold text-text-primary">{secret.label}</p>
                  <p className="text-caption text-text-secondary">{secret.where} We store it encrypted and show only the last 4 characters.</p>
                  <Input
                    label={secret.label}
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    value={token}
                    disabled={!manage}
                    placeholder={`Paste the ${secret.label.toLowerCase()}`}
                    onChange={(e) => setToken(e.target.value)}
                    onBlur={() => setTouched((t) => ({ ...t, token: true }))}
                    error={tokenErr ?? tokenApiErr ?? undefined}
                  />
                </div>
              </div>
              {hasTestCode(provider) && (
                <div className="flex gap-3">
                  <StepBadge n={3} done={false} />
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <p className="text-body font-semibold text-text-primary">Verify with a test event</p>
                    <p className="text-caption text-text-secondary">Optional but recommended. Copy the test event code from {meta.short} → Test events; after connecting, use Send test event.</p>
                    <Input
                      label="Test event code"
                      value={code}
                      disabled={!manage}
                      placeholder="TEST12345"
                      onChange={(e) => setCode(e.target.value)}
                      onBlur={() => setTouched((t) => ({ ...t, code: true }))}
                      error={codeErr ?? codeApiErr ?? undefined}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                </div>
              )}
              <Banner tone="info">Only IDs and tokens are accepted. Pixel base code, &lt;script&gt; tags and custom JavaScript can’t be pasted here and never run on your shop.</Banner>
              {otherErr && (
                <p role="alert" className="text-body text-danger">
                  {otherErr}
                </p>
              )}
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <p className="min-w-0 flex-1 text-caption text-text-secondary">Your shoppers’ phone numbers are hashed (SHA-256) before they leave Storeplix.</p>
                <Link to="/integrations" className={buttonVariants({ variant: 'ghost' })}>
                  Cancel
                </Link>
                {manage && (
                  <Button type="submit" loading={save.isPending}>
                    Connect {meta.short}
                  </Button>
                )}
              </div>
            </form>
          </Panel>
          <TableCard title="Events we’ll send" description={`Browser and server copies share one event ID, so ${meta.short} counts each once.`}>
            <table className="w-full min-w-[560px]">
              <TableHead cols={[{ label: 'Event' }, { label: 'When it fires' }, { label: 'Sent from' }, { label: 'Ready' }]} />
              <tbody>
                {providerEvents(provider).map((e) => (
                  <tr key={e}>
                    <td className={`${tdClass} font-medium text-text-primary`}>{providerEventName(provider, e)}</td>
                    <td className={tdClass}>{eventWhen[e]}</td>
                    <td className={tdClass}>{sentFrom(provider, e, true)}</td>
                    <td className={tdClass}>
                      <Badge size="sm">After connect</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableCard>
        </>
      }
      right={
        <>
          <Panel title="Before you start">
            <ul className="flex flex-col gap-2 text-body text-text-secondary">
              <li>· A {meta.short} account you can sign in to</li>
              <li>· {provider === 'ga4' ? 'A GA4 property with a web data stream' : 'A web pixel in Events Manager'}</li>
              <li>· Admin access to the {provider === 'ga4' ? 'property' : 'pixel'}</li>
            </ul>
          </Panel>
          <Tip title="Why no code box?">Code pasted into a shop could read your shoppers’ phone numbers and card pages. Storeplix connects tracking with IDs and tokens only and loads each ad platform’s official pixel itself.</Tip>
        </>
      }
    />
  );
}

// ---------- Overview (GA4 2132:53511 + the Settings content of Meta 2139:57369, Q365) ----------

function OverviewTab({ provider, row, manage }: { provider: PixelProvider; row: StoreIntegration<PixelProvider>; manage: boolean }) {
  const scope = useStoreScope();
  const stats = useTrackingStats(provider, 7);
  const mirror = !!row.settings && 'mirror_browser_events' in row.settings ? row.settings.mirror_browser_events : false;
  const code = testCodeOf(row.settings);
  return (
    <Columns
      left={
        <>
          <Panel title={`${PROVIDER_META[provider].idLabel} and ${provider === 'ga4' ? 'API secret' : 'access token'}`} description={ID_WHERE[provider]}>
            <div className="flex flex-col gap-4 sm:flex-row">
              <CopyRow label={PROVIDER_META[provider].idLabel} value={idOf(provider, row.settings)} />
              <SecretField provider={provider} row={row} manage={manage} />
            </div>
            <div className="flex flex-col gap-4 sm:flex-row">
              <ReadOnlyField label="Currency" value={`${scope.store?.currency ?? 'BDT'} · from your store settings`} />
              {hasTestCode(provider) && <ReadOnlyField label="Test event code" value={code ?? 'Not set'} />}
            </div>
            <Banner tone="success">{DEDUP[provider]}</Banner>
          </Panel>
          {stats.isError ? (
            <StateCard>
              <ErrorBlock title="We couldn’t load the event counts" error={stats.error} onRetry={() => void stats.refetch()} />
            </StateCard>
          ) : stats.isPending ? (
            <Skeleton className="h-72 rounded-card" />
          ) : (
            <EventStatsTable provider={provider} stats={stats.data} mirror={mirror} title={provider === 'ga4' ? 'Ecommerce events · last 7 days' : 'Events · last 7 days'} />
          )}
          {manage && <IdsPanel provider={provider} row={row} />}
          <TrackingSettingsPanel provider={provider} row={row} manage={manage} />
        </>
      }
      right={
        <>
          <ConnectionCheckCard provider={provider} canRun={manage} />
          <TotalsCard provider={provider} days={30} />
          <Tip title="Tokens are write-only">We store the {provider === 'ga4' ? 'API secret' : 'access token'} encrypted and never show it again. To change it, choose Replace and paste a new one. Every change is saved to your activity log.</Tip>
          <Tip title={PROVIDER_META[provider].tip.title}>{PROVIDER_META[provider].tip.body}</Tip>
        </>
      }
    />
  );
}

function SecretField({ provider, row, manage }: { provider: PixelProvider; row: StoreIntegration<PixelProvider>; manage: boolean }) {
  const save = useSaveIntegration(provider);
  const secret = SECRET[provider];
  return (
    <WriteOnlySecret
      label={secret.label}
      hint={row.credentials_hint[secret.key]}
      updatedAt={row.last_verified_at}
      canReplace={manage}
      saving={save.isPending}
      error={save.error ? integrationErrorText(save.error, provider) : null}
      validate={(v) => secretProblem(v, secret.label)}
      onSave={(value, done) =>
        row.settings &&
        save.mutate(
          { settings: row.settings, credentials: { [secret.key]: value } as never, revision: row.revision },
          {
            onSuccess: () => {
              toast(`${secret.label} replaced`);
              done();
            },
          },
        )
      }
    />
  );
}

// ---------- Test & verify (Meta 2134:64916) ----------

function TestTab({
  provider,
  row,
  manage,
  sending,
  result,
  error,
  onSend,
  onOverview,
}: {
  provider: PixelProvider;
  row: StoreIntegration<PixelProvider>;
  manage: boolean;
  sending: boolean;
  result: TrackingTestResult | null;
  error: unknown;
  onSend: (e: TrackingEventName) => void;
  onOverview: () => void;
}) {
  const [event, setEvent] = useState<TrackingEventName>('purchase');
  const [mode, setMode] = useState<TrackingTestMode | null>(null);
  const start = useStartTestMode(provider);
  const left = useCountdown(mode?.expires_at);
  const testOn = !!mode && left !== null && left > 0;
  const code = testCodeOf(row.settings);
  const supportsMode = hasTestCode(provider);
  return (
    <Columns
      left={
        <>
          <Panel
            title="Test your setup"
            description={provider === 'ga4' ? 'Test events go to GA4’s validation server and are never counted in your reports.' : `Test events show only in ${PROVIDER_META[provider].short}’s Test events tab and are never used for your ads.`}
            actions={
              testOn ? (
                <Badge tone="info" size="sm">
                  Test mode on · {Math.ceil((left ?? 0) / 60_000)} min left
                </Badge>
              ) : undefined
            }
          >
            {supportsMode && (
              <div className="flex flex-col gap-2">
                <p className="text-body font-semibold text-text-primary">Open your shop in test mode</p>
                <p className="text-caption text-text-secondary">Opens your shop in a new tab with your test code attached for 30 minutes. Events from that tab show below.</p>
                {code ? (
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                    <CopyRow label="Test event code" value={code} />
                    {manage && (
                      <Button
                        variant="secondary"
                        loading={start.isPending}
                        onClick={() =>
                          start.mutate(undefined, {
                            onSuccess: (m) => {
                              setMode(m);
                              window.open(m.url, '_blank', 'noopener,noreferrer');
                            },
                            onError: (e) => toast(integrationErrorText(e, provider), 'error'),
                          })
                        }
                      >
                        Open shop in test mode ↗
                      </Button>
                    )}
                  </div>
                ) : (
                  <p className="text-body text-text-secondary">
                    Add your test event code on the{' '}
                    <button type="button" onClick={onOverview} className="rounded-sm font-medium text-brand-600 outline-none hover:underline focus-visible:shadow-focus">
                      Overview tab
                    </button>{' '}
                    to use test mode.
                  </p>
                )}
              </div>
            )}
            <div className="flex flex-col gap-2">
              <p className="text-body font-semibold text-text-primary">Send a test event from our server</p>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <Select label="Event" value={event} onChange={(e) => setEvent(e.target.value as TrackingEventName)} containerClassName="sm:w-60">
                  {providerEvents(provider)
                    .filter((e) => e !== 'refund')
                    .map((e) => (
                      <option key={e} value={e}>
                        {providerEventName(provider, e)}
                      </option>
                    ))}
                </Select>
                {manage && (
                  <Button loading={sending} onClick={() => onSend(event)}>
                    Send test event
                  </Button>
                )}
              </div>
              {result ? (
                result.delivered ? (
                  <Banner tone="success">
                    {providerEventName(provider, result.event) ?? result.event} delivered{result.http_status ? ` · HTTP ${result.http_status}` : ''}. Event ID {result.event_id}.
                  </Banner>
                ) : (
                  <Banner tone="danger">
                    <p>Not accepted{result.http_status ? ` (HTTP ${result.http_status})` : ''}.{result.provider_message ? ` ${result.provider_message}` : ''}</p>
                    {result.validation_messages.length > 0 && (
                      <ul className="mt-1 list-disc pl-4 font-normal">
                        {result.validation_messages.map((m) => (
                          <li key={m}>{m}</li>
                        ))}
                      </ul>
                    )}
                  </Banner>
                )
              ) : error ? (
                <Banner tone="danger">{integrationErrorText(error, provider)}</Banner>
              ) : null}
            </div>
          </Panel>
          <EventLog provider={provider} title="Test events received" description={testOn ? 'Updates every 5 seconds while test mode is on.' : 'Test events from the last 24 hours.'} test poll={testOn} compact />
        </>
      }
      right={
        <>
          <ConnectionCheckCard provider={provider} canRun={manage} />
          <Tip title="Test events stay out of reports">Test events carry a test flag, are never counted in the stats on this page and never reach your ad reports.</Tip>
        </>
      }
    />
  );
}

// ---------- Settings content (Meta 2139:57369), shown on Overview (Q365) ----------

/** Change the ID (and test event code for Meta / TikTok): PUT with the revision; the stored token is kept. */
function IdsPanel({ provider, row }: { provider: PixelProvider; row: StoreIntegration<PixelProvider> }) {
  const save = useSaveIntegration(provider);
  const settings = row.settings ?? row.defaults;
  const [id, setId] = useState(idOf(provider, settings));
  const [code, setCode] = useState(testCodeOf(settings) ?? '');
  const [touched, setTouched] = useState(false);
  const idErr = touched ? idProblem(provider, id) : null;
  const codeErr = touched && hasTestCode(provider) ? testCodeProblem(code) : null;
  const dirty = normalizeId(provider, id) !== idOf(provider, settings) || (hasTestCode(provider) && (code.trim() || null) !== testCodeOf(settings));
  const apiField = errorField(save.error);
  return (
    <Panel title={`Change ${PROVIDER_META[provider].idLabel}${hasTestCode(provider) ? ' or test code' : ''}`} description="Only IDs are accepted. Your token keeps working.">
      <form
        className="flex flex-col gap-4"
        noValidate
        aria-label={`Change ${PROVIDER_META[provider].idLabel}`}
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (idProblem(provider, id) || (hasTestCode(provider) && testCodeProblem(code))) return;
          save.mutate(
            { settings: { ...settings, [ID_KEY[provider]]: normalizeId(provider, id), ...(hasTestCode(provider) ? { test_event_code: code.trim() || null } : {}) } as PixelSettings, revision: row.revision },
            { onSuccess: () => toast('Saved') },
          );
        }}
      >
        <div className="flex flex-col gap-4 sm:flex-row">
          <Input label={PROVIDER_META[provider].idLabel} value={id} onChange={(e) => setId(e.target.value)} error={idErr ?? (apiField === ID_KEY[provider] ? integrationErrorText(save.error, provider) : undefined)} containerClassName="flex-1" autoComplete="off" spellCheck={false} />
          {hasTestCode(provider) && (
            <Input label="Test event code" value={code} placeholder="TEST12345" onChange={(e) => setCode(e.target.value)} error={codeErr ?? (apiField === 'test_event_code' ? integrationErrorText(save.error, provider) : undefined)} containerClassName="flex-1" autoComplete="off" spellCheck={false} />
          )}
        </div>
        {save.error && !apiField ? (
          <p role="alert" className="text-body text-danger">
            {integrationErrorText(save.error, provider)}
          </p>
        ) : null}
        <Button type="submit" className="self-start" disabled={!dirty} loading={save.isPending}>
          Save
        </Button>
      </form>
    </Panel>
  );
}

function TrackingSettingsPanel({ provider, row, manage }: { provider: PixelProvider; row: StoreIntegration<PixelProvider>; manage: boolean }) {
  const update = useUpdateSettings(provider);
  const settings = row.settings ?? row.defaults;
  const patch = (s: Partial<PixelSettings>) =>
    update.mutate({ settings: s, revision: row.revision }, { onSuccess: () => toast('Settings saved'), onError: (e) => toast(integrationErrorText(e, provider), 'error') });
  const toggle = (key: keyof PixelSettings, title: string, description: string) => {
    const value = (settings as unknown as Record<string, unknown>)[key as string];
    return <SettingRow title={title} description={description} control={<Toggle label={title} checked={value === true} disabled={!manage || update.isPending} onChange={(v) => patch({ [key]: v } as Partial<PixelSettings>)} />} />;
  };
  return (
    <Panel title="Tracking settings" label="Tracking settings">
      <div className="flex flex-col">
        <SettingRow
          title={`Send ${providerEventName(provider, 'purchase')} when`}
          description="Counting at confirmation keeps fake COD orders out of your reports."
          control={
            <Select aria-label="Send purchase when" value={settings.purchase_trigger} disabled={!manage || update.isPending} onChange={(e) => patch({ purchase_trigger: e.target.value as PurchaseTrigger })}>
              {(Object.keys(purchaseTriggerLabel) as PurchaseTrigger[]).map((t) => (
                <option key={t} value={t}>
                  {purchaseTriggerLabel[t]}
                </option>
              ))}
            </Select>
          }
        />
        {provider === 'ga4' && toggle('send_refunds' as keyof PixelSettings, 'Send refunds and returns', 'Lowers revenue in GA4 when an order is returned.')}
        {provider !== 'ga4' && toggle('mirror_browser_events' as keyof PixelSettings, 'Send browser events from our server too', 'Keeps ads working when cookies are blocked. Copies share one event ID, so they count once.')}
        {toggle('send_customer_data', 'Advanced matching', 'Send phone and email SHA-256 hashed, never in plain text.')}
        {toggle('wait_for_consent', 'Wait for cookie consent', 'Browser events start only after the shopper accepts the cookie banner. Purchases are sent only for shoppers who accepted.')}
        {toggle('include_delivery_charge', 'Include delivery charge in value', 'Off: value is the product total after discounts.')}
      </div>
    </Panel>
  );
}
