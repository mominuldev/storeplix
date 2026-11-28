import { isApiError } from '@storeplix/api-client';
import { GA4_MEASUREMENT_ID_PATTERN, looksLikePastedCode, type GtmServerSettings, type PurchaseTrigger, type StoreIntegration, type TrackingEventName } from '@storeplix/types';
import { Badge, Button, buttonVariants, Checkbox, Input, Select, Skeleton, Toggle } from '@storeplix/ui';
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, StateCard } from '../catalog/states';
import { useReadOnly } from '../impersonation/hooks';
import { can as perm } from '../lib/permissions';
import { toast } from '../online-store/components/Toast';
import {
  Banner,
  Breadcrumb,
  CheckRow,
  Columns,
  connectedMeta,
  ConnectionCheckCard,
  CopyRow,
  DetailTabs,
  DisconnectDialog,
  IntegrationHeader,
  Panel,
  PausedBanner,
  ReadOnlyField,
  SettingRow,
  Tip,
  UpgradeState,
} from './components';
import {
  attentionText,
  errorField,
  eventWhen,
  GTM_TAB_LABELS,
  GTM_TABS,
  idProblem,
  integrationErrorText,
  isLive,
  normalizeId,
  parseTab,
  PROVIDER_META,
  purchaseTriggerLabel,
  taggingUrlChecks,
  taggingUrlProblem,
  type GtmTab,
} from './integrations';
import { useIntegration, useSaveIntegration, useUpdateSettings } from './queries';
import { EventLog, TotalsCard } from './tracking';

// PHASE-8-9D §8 Google Tag Manager (server) `/integrations/gtm` (Figma 2133:54292, URL error 2140:58941). Server
// container only (P89D-9): a web container would run merchant JavaScript, so it is refused ("Use a server container").
// Plan: `server_side_tagging` (Growth). Tabs Overview · Forwarding log · Settings. No secrets.

const PROVIDER = 'gtm_server' as const;
const ALL_EVENTS: TrackingEventName[] = ['page_view', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase', 'refund'];
const STOPS = ['Forwarding events to your tagging server', 'Retries of events still waiting'];

function measurementProblem(raw: string): string | null {
  const v = raw.trim().toUpperCase();
  if (!v) return 'Enter the GA4 Measurement ID the events are sent as.';
  if (looksLikePastedCode(v)) return 'This looks like code. Paste only the Measurement ID — e.g. G-7K2QX9M4LP.';
  return GA4_MEASUREMENT_ID_PATTERN.test(v) ? null : 'Measurement IDs start with G-, e.g. G-7K2QX9M4LP.';
}

export function GtmPage() {
  const scope = useStoreScope();
  const { activeTenant } = useAuth();
  const readOnly = useReadOnly();
  const row = useIntegration(PROVIDER);
  const [params, setParams] = useSearchParams();
  const tab = parseTab<GtmTab>(params.get('tab'), GTM_TABS);
  const [disconnecting, setDisconnecting] = useState(false);
  const go = (t: GtmTab) => setParams(t === 'overview' ? {} : { tab: t });
  const canSeePlans = perm.viewBilling(activeTenant);

  if (row.isPending) {
    return (
      <div className="flex flex-col gap-5" aria-busy="true" aria-label="Loading integration">
        <Breadcrumb provider={PROVIDER} />
        <Skeleton className="h-36 rounded-card" />
        <Skeleton className="h-96 rounded-card" />
      </div>
    );
  }
  if (row.isError) {
    return (
      <div className="flex flex-col gap-5">
        <Breadcrumb provider={PROVIDER} />
        <StateCard>
          <ErrorBlock title="We couldn’t load Google Tag Manager" error={row.error} onRetry={() => void row.refetch()} />
        </StateCard>
      </div>
    );
  }
  const data = row.data;
  const manage = scope.canManageIntegrations && data.can.manage && !readOnly;
  const live = isLive(data.status);
  const gated = data.plan_required === 'server_side_tagging';

  return (
    <div className="flex flex-col gap-5">
      <Breadcrumb provider={PROVIDER} />
      <IntegrationHeader
        provider={PROVIDER}
        status={data.status}
        meta={live && data.settings ? connectedMeta(data, [{ icon: 'shield', text: `Server container ${data.settings.container_id}` }]) : [{ icon: 'shield', text: 'Growth plan · your own server container' }]}
        onDisconnect={live && manage ? () => setDisconnecting(true) : undefined}
      />
      {!scope.canManageIntegrations && <p className="rounded-md bg-surface-subtle px-3 py-2 text-body text-text-secondary">Only owners and managers can connect or change integrations.</p>}
      {!live && gated ? (
        <UpgradeState feature="server_side_tagging" canSeePlans={canSeePlans} />
      ) : !live ? (
        <Columns left={<><SetupForm row={data} manage={manage} /><WebContainersCard /></>} right={<Tip title={PROVIDER_META[PROVIDER].tip.title}>{PROVIDER_META[PROVIDER].tip.body}</Tip>} />
      ) : (
        <>
          <DetailTabs label="Google Tag Manager sections" value={tab} onChange={go} items={GTM_TABS.map((t) => ({ value: t, label: GTM_TAB_LABELS[t] }))} />
          {gated && <PausedBanner feature="server_side_tagging" canSeePlans={canSeePlans} />}
          {data.attention
            .filter((a) => a.reason !== 'plan_required')
            .map((a) => (
              <Banner key={a.reason} tone={data.status === 'error' ? 'danger' : 'warning'}>
                {attentionText(a, PROVIDER)}
              </Banner>
            ))}
          {tab === 'overview' && (
            <Columns
              left={
                <>
                  <ServerContainerCard row={data} manage={manage} />
                  <WebContainersCard />
                  <EventLog provider={PROVIDER} title="Forwarding log" description="The latest events sent to your tagging server." compact />
                </>
              }
              right={
                <>
                  <TotalsCard provider={PROVIDER} days={7} />
                  <ConnectionCheckCard provider={PROVIDER} canRun={manage} />
                  <Tip title={PROVIDER_META[PROVIDER].tip.title}>{PROVIDER_META[PROVIDER].tip.body}</Tip>
                </>
              }
            />
          )}
          {tab === 'log' && <EventLog provider={PROVIDER} title="Forwarding log" description="Every event forwarded to your tagging server. Failed events are retried for 24 hours." />}
          {tab === 'settings' && <ForwardingSettings row={data} manage={manage} />}
        </>
      )}
      {disconnecting && <DisconnectDialog provider={PROVIDER} stops={STOPS} keepNote="Your container and its tags stay in Tag Manager." onClose={() => setDisconnecting(false)} />}
    </div>
  );
}

function SetupForm({ row, manage }: { row: StoreIntegration<'gtm_server'>; manage: boolean }) {
  const save = useSaveIntegration(PROVIDER);
  const [container, setContainer] = useState(row.settings?.container_id ?? '');
  const [url, setUrl] = useState(row.settings?.tagging_server_url ?? '');
  const [mid, setMid] = useState(row.settings?.measurement_id ?? '');
  const [touched, setTouched] = useState(false);
  const field = errorField(save.error);
  const apiMsg = save.error ? integrationErrorText(save.error, PROVIDER) : null;
  const urlApi = (isApiError(save.error) && save.error.code === 'integration_endpoint_blocked') || field === 'tagging_server_url' ? apiMsg : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (idProblem(PROVIDER, container) || taggingUrlProblem(url) || measurementProblem(mid)) return;
    save.mutate(
      {
        settings: { ...row.defaults, container_id: normalizeId(PROVIDER, container), tagging_server_url: url.trim(), measurement_id: mid.trim().toUpperCase() },
        ...(row.status !== 'not_connected' ? { revision: row.revision } : {}),
      },
      { onSuccess: () => toast('Google Tag Manager connected') },
    );
  };
  return (
    <Panel title="Connect your server container" description="From Tag Manager → Admin → Container settings (Server).">
      <form className="flex flex-col gap-4" noValidate onSubmit={submit} aria-label="Connect Google Tag Manager">
        <Input label="Server container ID" value={container} disabled={!manage} placeholder="GTM-W8K3PZ5" onChange={(e) => setContainer(e.target.value)} error={(touched ? idProblem(PROVIDER, container) : null) ?? (field === 'container_id' ? apiMsg : null) ?? undefined} autoComplete="off" spellCheck={false} />
        <Input label="Tagging server URL" value={url} disabled={!manage} placeholder="https://sgtm.yourshop.com" onChange={(e) => setUrl(e.target.value)} error={(touched ? taggingUrlProblem(url) : null) ?? urlApi ?? undefined} autoComplete="off" spellCheck={false} />
        <Input label="Events are sent as (GA4 Measurement ID)" value={mid} disabled={!manage} placeholder="G-7K2QX9M4LP" onChange={(e) => setMid(e.target.value)} error={(touched ? measurementProblem(mid) : null) ?? (field === 'measurement_id' ? apiMsg : null) ?? undefined} autoComplete="off" spellCheck={false} />
        {apiMsg && !urlApi && !field && (
          <p role="alert" className="text-body text-danger">
            {apiMsg}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Link to="/integrations" className={buttonVariants({ variant: 'ghost' })}>
            Cancel
          </Link>
          {manage && (
            <Button type="submit" loading={save.isPending}>
              Check and connect
            </Button>
          )}
        </div>
      </form>
    </Panel>
  );
}

function ServerContainerCard({ row, manage }: { row: StoreIntegration<'gtm_server'>; manage: boolean }) {
  const save = useSaveIntegration(PROVIDER);
  const s = row.settings!;
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(s.tagging_server_url);
  const problem = taggingUrlProblem(url);
  const unreachable = row.attention.some((a) => a.reason === 'endpoint_unreachable');
  return (
    <Panel title="Server container" description="From Tag Manager → Admin → Container settings (Server).">
      <div className="flex flex-col gap-4 sm:flex-row">
        <CopyRow label="Server container ID" value={s.container_id} />
        {editing ? (
          <div className="min-w-0 flex-1">
            <Input label="Tagging server URL" value={url} onChange={(e) => setUrl(e.target.value)} error={url !== s.tagging_server_url && problem ? problem : save.error ? integrationErrorText(save.error, PROVIDER) : undefined} autoFocus autoComplete="off" spellCheck={false} />
          </div>
        ) : (
          <ReadOnlyField
            label="Tagging server URL"
            value={
              <span className="flex w-full items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{s.tagging_server_url}</span>
                {manage && (
                  <button type="button" onClick={() => setEditing(true)} aria-label="Edit tagging server URL" className="shrink-0 rounded-sm text-caption font-medium text-brand-600 outline-none hover:underline focus-visible:shadow-focus">
                    Edit
                  </button>
                )}
              </span>
            }
          />
        )}
      </div>
      <div className="flex flex-col gap-4 sm:flex-row">
        <ReadOnlyField label="Events are sent as" value={`GA4 events · ${s.measurement_id}`} />
        <ReadOnlyField label="Server health" value={editing && problem ? 'Not checked · fix the URL first' : unreachable ? 'Not responding' : 'Responding'} />
      </div>
      {editing ? (
        <>
          {problem && <Banner tone="danger">Not saved. Events keep going to {s.tagging_server_url} until a new URL passes every check below.</Banner>}
          <ul className="flex flex-col gap-2" aria-label="URL checks">
            {taggingUrlChecks(url).map((c) => (
              <CheckRow key={c.label} label={c.label} state={c.state} />
            ))}
          </ul>
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setEditing(false);
                setUrl(s.tagging_server_url);
                save.reset();
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={!!problem || url.trim() === s.tagging_server_url}
              loading={save.isPending}
              onClick={() =>
                save.mutate(
                  { settings: { ...s, tagging_server_url: url.trim() }, revision: row.revision },
                  {
                    onSuccess: () => {
                      toast('Tagging server URL saved');
                      setEditing(false);
                    },
                  },
                )
              }
            >
              Check and save
            </Button>
          </div>
        </>
      ) : unreachable ? (
        <Banner tone="warning">We couldn’t reach {s.tagging_server_url}/healthy. Events are retried for 24 hours.</Banner>
      ) : (
        <Banner tone="success">Tagging server reached · events are forwarded from our server</Banner>
      )}
    </Panel>
  );
}

function WebContainersCard() {
  return (
    <Panel
      title="Web containers aren’t supported"
      actions={
        <Badge tone="warning" size="sm">
          By design
        </Badge>
      }
    >
      <p className="text-body text-text-secondary">
        A web container (gtm.js) runs any JavaScript added in Tag Manager on your shop. Storeplix never runs shop-provided code in shoppers’ browsers, so only server containers can be connected. For browser tracking, connect Meta Pixel, Google Analytics 4 or TikTok Pixel directly.
      </p>
      <Banner tone="warning">Pasting a web container ID (or gtm.js snippet) shows “Use a server container”.</Banner>
    </Panel>
  );
}

function ForwardingSettings({ row, manage }: { row: StoreIntegration<'gtm_server'>; manage: boolean }) {
  const update = useUpdateSettings(PROVIDER);
  const s: GtmServerSettings = row.settings ?? row.defaults;
  const patch = (p: Partial<GtmServerSettings>) => update.mutate({ settings: p, revision: row.revision }, { onSuccess: () => toast('Settings saved'), onError: (e) => toast(integrationErrorText(e, PROVIDER), 'error') });
  const off = !manage || update.isPending;
  return (
    <Columns
      left={
        <Panel title="Forwarding settings" label="Forwarding settings">
          <div className="flex flex-col">
            <div className="flex flex-col gap-2 border-b border-border-default py-3.5">
              <p className="text-body font-semibold text-text-primary">Events to forward</p>
              <p className="text-caption text-text-secondary">Page views, product views, cart, checkout, purchase and refund. At least one.</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {ALL_EVENTS.map((e) => {
                  const on = s.events.includes(e);
                  return (
                    <Checkbox
                      key={e}
                      label={`${e} · ${eventWhen[e]}`}
                      checked={on}
                      disabled={off || (on && s.events.length === 1)}
                      onChange={(ev) => patch({ events: ev.target.checked ? ALL_EVENTS.filter((x) => x === e || s.events.includes(x)) : s.events.filter((x) => x !== e) })}
                    />
                  );
                })}
              </div>
            </div>
            <SettingRow
              title="Send purchase when"
              description="Counting at confirmation keeps fake COD orders out of your reports."
              control={
                <Select aria-label="Send purchase when" value={s.purchase_trigger} disabled={off} onChange={(e) => patch({ purchase_trigger: e.target.value as PurchaseTrigger })}>
                  {(Object.keys(purchaseTriggerLabel) as PurchaseTrigger[]).map((t) => (
                    <option key={t} value={t}>
                      {purchaseTriggerLabel[t]}
                    </option>
                  ))}
                </Select>
              }
            />
            <SettingRow title="Send hashed phone and email" description="Lets tags in your container match buyers. Hashed with SHA-256." control={<Toggle label="Send hashed phone and email" checked={s.send_customer_data} disabled={off} onChange={(v) => patch({ send_customer_data: v })} />} />
            <SettingRow title="Wait for cookie consent" description="Events are forwarded only for shoppers who accept the cookie banner." control={<Toggle label="Wait for cookie consent" checked={s.wait_for_consent} disabled={off} onChange={(v) => patch({ wait_for_consent: v })} />} />
            <SettingRow title="Include delivery charge in value" description="Off: value is the product total after discounts." control={<Toggle label="Include delivery charge in value" checked={s.include_delivery_charge} disabled={off} onChange={(v) => patch({ include_delivery_charge: v })} />} />
          </div>
          <p className="text-caption text-text-secondary">Failed events are retried for 24 hours, then dropped and shown as Failed.</p>
        </Panel>
      }
      right={<Tip title={PROVIDER_META[PROVIDER].tip.title}>{PROVIDER_META[PROVIDER].tip.body}</Tip>}
    />
  );
}
