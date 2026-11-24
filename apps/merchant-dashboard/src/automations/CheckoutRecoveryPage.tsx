import { isApiError } from '@storeplix/api-client';
import {
  RECIPE_PARAMS,
  type AutomationDetail,
  type AutomationMessage,
  type AutomationOf,
  type AutomationRun,
  type AutomationStats,
  type CheckoutRecoverySettings,
  type Coupon,
} from '@storeplix/types';
import { Badge, BarChart, Button, cn, KpiTile, Menu, Skeleton, Toggle, type BarDatum } from '@storeplix/ui';
import { BarChart3, Check, Mail, MessageCircle, RefreshCw, Send, ShoppingCart, ImageOff } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { allowanceLeft, allowanceOf } from '../campaigns/campaigns';
import { formatBdt, formatCount, shortDate } from '../catalog/format';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, errorMessage, LoadingRows, StateCard } from '../catalog/states';
import { useCoupons } from '../commerce/queries';
import { PageHeader } from '../layout/PageHeader';
import { toast } from '../online-store/components/Toast';
import { useFeatures } from '../plan/useFeatures';
import { automationsLocked, automationStatusMeta, cartLine, incompleteMessage, messageProblem, previewText, recoveryPill, renderAutomationSms } from './automations';
import { useAutomation, useAutomationRuns, useAutomations, useAutomationStats, useAutomationTestMessage, useCreateAutomation, useToggleAutomation, useUpdateAutomation } from './queries';
import { AutomationPlanNote, Card, Connector, IconBadge, InlineSelect, MessageDialog, PausedPill, WaitPill } from './ui';

// Figma Abandoned cart recovery 71:20614, PHASE-8-6 §10.3. Header + status pill + "Send test" + "Save changes"; KPI tiles
// Carts left behind, Recovered, Revenue won back, Messages sent (composed; replaces "Cost"); Recovery flow card: trigger,
// "Wait {delay} minutes" (select), Step 1 (Recovery/Step 71:20588 — channel icon, toggle, message with the first product
// photo, stats Sent · Recovered · Revenue; "Clicked" hidden), "Wait {hours} hours · only if still no order", Step 2
// (coupon select), "Stop when an order is placed", exit row; "Add a step" hidden. Side: Recent carts (polls 60 s),
// Recovered per day (14 bars), Rules (Skip risky, Quiet hours on/disabled, One coupon per phone read-only). WhatsApp is
// not offered. Below `lg` the side cards stack under the flow (Q166).

const DELAYS = RECIPE_PARAMS.checkout_recovery.delay_minutes.options;
const WAIT_HOURS = [6, 12, 24, 36, 48];
const EXIT_DAYS = [1, 2, 3, 4, 5, 6, 7];

export function CheckoutRecoveryPage() {
  const scope = useStoreScope();
  const features = useFeatures();
  const locked = automationsLocked(features.data);
  const list = useAutomations();
  const row = list.data?.data.find((a) => a.recipe === 'checkout_recovery');
  const detail = useAutomation(row?.id);

  const header = (actions?: ReactNode, pill?: ReactNode) => (
    <PageHeader
      title={
        <span className="flex flex-wrap items-center gap-3">
          Abandoned cart recovery
          {pill}
        </span>
      }
      subtitle="Buyers who start checkout and leave get a gentle reminder — automatically, day and night."
      actions={actions}
    />
  );

  if (list.isPending || (row && detail.isPending))
    return (
      <>
        {header()}
        <div role="status" aria-label="Loading cart recovery" className="flex flex-col gap-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-[118px] rounded-card" />
            ))}
          </div>
          <Skeleton className="h-[600px] rounded-card" />
        </div>
      </>
    );
  const error = list.error ?? detail.error;
  if (error)
    return (
      <>
        {header()}
        <StateCard>
          <ErrorBlock title="We couldn’t load cart recovery" error={error} onRetry={() => void (list.isError ? list.refetch() : detail.refetch())} />
        </StateCard>
      </>
    );
  if (!row || !detail.data || detail.data.recipe !== 'checkout_recovery')
    return (
      <>
        {header()}
        {features.data && locked && <AutomationPlanNote canSeePlans={scope.canViewBilling} />}
        <NotSetUp locked={locked} />
      </>
    );
  return <Recovery key={`${detail.data.id}:${detail.data.revision}`} automation={detail.data as AutomationDetail & AutomationOf<'checkout_recovery'>} header={header} locked={locked} />;
}

function NotSetUp({ locked }: { locked: boolean }) {
  const create = useCreateAutomation();
  return (
    <StateCard>
      <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
        <IconBadge icon={ShoppingCart} tone="brand" size={40} />
        <h2 className="text-body-lg font-medium text-text-primary">Win back unfinished orders</h2>
        <p className="max-w-md text-body text-text-secondary">When a buyer types their phone at checkout and leaves, send up to two reminders with a link back to their cart.</p>
        <Button
          disabled={locked}
          loading={create.isPending}
          onClick={() => create.mutate('checkout_recovery', { onError: (e) => toast(isApiError(e) && e.status === 402 ? 'Automations are part of the Starter plan.' : errorMessage(e), 'error') })}
        >
          Set up flow
        </Button>
      </div>
    </StateCard>
  );
}

type RecoveryAutomation = AutomationDetail & AutomationOf<'checkout_recovery'>;

function Recovery({ automation, header, locked }: { automation: RecoveryAutomation; header: (actions?: ReactNode, pill?: ReactNode) => ReactNode; locked: boolean }) {
  const scope = useStoreScope();
  const features = useFeatures();
  const navigate = useNavigate();
  const update = useUpdateAutomation();
  const toggle = useToggleAutomation();
  const test = useAutomationTestMessage();
  const stats = useAutomationStats(automation.id, 14);
  const runs = useAutomationRuns({ automation_id: automation.id }, { poll: 60_000 });
  const coupons = useCoupons({ status: ['active'], per_page: 50 });
  const [settings, setSettings] = useState<CheckoutRecoverySettings>(() => structuredClone(automation.settings));
  const [editing, setEditing] = useState<1 | 2 | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const dirty = JSON.stringify(settings) !== JSON.stringify(automation.settings);
  const couponList = coupons.data?.data ?? [];
  const coupon = couponList.find((c) => c.id === settings.step2.coupon_id) ?? null;
  const shopName = scope.store?.name ?? 'Shop';
  const host = scope.store?.primary_domain ?? 'shop.storeplix.com';
  const runRows = runs.data?.pages[0]?.data ?? [];
  const sample = runRows.find((r) => r.context.first_product_name);
  const productName = sample?.context.first_product_name ?? null;
  const productImage = runRows.find((r) => r.context.first_product_image_url)?.context.first_product_image_url ?? null;

  const set = (patch: Partial<CheckoutRecoverySettings>) => setSettings((s) => ({ ...s, ...patch }));
  const smsOf = (m: AutomationMessage, code: string | null) => renderAutomationSms(m.body, { language: m.language, shopName, host, couponCode: code, productName });

  const save = () => {
    const e: Record<string, string> = {};
    for (const [k, step, code] of [
      ['step1', settings.step1, null],
      ['step2', settings.step2, coupon?.code ?? null],
    ] as const) {
      if (!step.enabled) continue;
      const p = messageProblem('checkout_recovery', step.message, step.message.channel === 'sms' ? smsOf(step.message, code).count.parts : null);
      if (p) e[k] = p;
    }
    if (settings.step2.enabled && settings.step2.message.body.includes('{coupon}') && !settings.step2.coupon_id) e.step2 = 'Pick a coupon for {coupon}.';
    setErrors(e);
    if (Object.keys(e).length) {
      toast('Check the highlighted steps.', 'error');
      return;
    }
    update.mutate(
      { id: automation.id, input: { settings, revision: automation.revision } },
      {
        onSuccess: () => toast('Changes saved.'),
        onError: (err) => toast(isApiError(err) && err.code === 'revision_conflict' ? 'Someone else changed this flow. We loaded the latest version — check and save again.' : errorMessage(err), 'error'),
      },
    );
  };

  const onToggle = (on: boolean) => {
    if (on && dirty) {
      toast('Save your changes first.', 'error');
      return;
    }
    toggle.mutate(
      { id: automation.id, on },
      {
        onSuccess: () => toast(on ? 'Cart recovery is on.' : 'Cart recovery is off. Waiting reminders are stopped.'),
        onError: (err) =>
          toast(isApiError(err) && err.code === 'automation_incomplete' ? incompleteMessage(err.details as Record<string, unknown> | undefined) : isApiError(err) && err.status === 402 ? 'Automations are part of the Starter plan.' : errorMessage(err), 'error'),
      },
    );
  };

  const sendTest = (step: 1 | 2) =>
    test.mutate(
      { id: automation.id, step },
      {
        onSuccess: (r) => toast(`Test sent to ${r.to_masked}.`),
        onError: (err) =>
          toast(
            isApiError(err) && err.status === 429
              ? 'You can send 5 tests an hour. Try again later.'
              : isApiError(err) && err.code === 'plan_limit_reached'
                ? 'Not enough marketing SMS left this month.'
                : isApiError(err) && err.status === 402
                  ? 'Automations are part of the Starter plan.'
                  : errorMessage(err),
            'error',
          ),
      },
    );

  const status = automationStatusMeta[automation.status];
  const pill = (
    <>
      <Badge tone={status.tone} dot>
        {status.label}
      </Badge>
      {automation.paused_reason === 'plan' && <PausedPill />}
    </>
  );
  const stepStats = (n: number) => stats.data?.steps.find((x) => x.step === n);
  const stepBusy = test.isPending;

  return (
    <>
      {header(
        <>
          {settings.step2.enabled ? (
            <Menu
              label="Send test"
              align="end"
              disabled={locked || stepBusy}
              trigger={<span>Send test</span>}
              triggerClassName="h-10 w-auto rounded-md border border-border-default bg-surface-card px-4 text-body font-semibold text-text-primary hover:bg-surface-subtle"
              entries={[
                { key: '1', label: 'Test step 1', onSelect: () => sendTest(1) },
                { key: '2', label: 'Test step 2', onSelect: () => sendTest(2) },
              ]}
              className="w-[180px]"
            />
          ) : (
            <Button variant="secondary" disabled={locked} loading={stepBusy} onClick={() => sendTest(1)}>
              Send test
            </Button>
          )}
          <Button onClick={save} loading={update.isPending} disabled={!dirty}>
            Save changes
          </Button>
        </>,
        pill,
      )}
      {features.data && locked && <AutomationPlanNote canSeePlans={scope.canViewBilling} />}

      <Kpis stats={stats.data} pending={stats.isPending} features={features.data} />

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <Card
          title="Recovery flow"
          subtitle="Runs for every unfinished checkout with a phone number"
          className="flex-1 gap-4"
          action={<Toggle label="Automation on" checked={automation.status === 'on'} disabled={toggle.isPending || (locked && automation.status !== 'on')} onChange={onToggle} />}
        >
          <div className="flex flex-col items-stretch">
            <Row dashed icon={<IconBadge icon={ShoppingCart} tone="danger" size={40} />} eyebrow="Trigger" title="Checkout started, not finished" line="Phone captured at checkout · cart with items" />
            <Connector>
              <WaitPill>
                Wait
                <InlineSelect label="Wait before step 1" value={String(settings.delay_minutes)} onChange={(v) => set({ delay_minutes: Number(v) })} options={DELAYS.map((d) => ({ value: String(d), label: String(d) }))} />
                minutes
              </WaitPill>
            </Connector>
            <StepCard
              n={1}
              when={`Step 1 · after ${settings.delay_minutes} minutes`}
              title={settings.step1.message.channel === 'email' ? 'Send email reminder' : 'Send SMS reminder'}
              message={settings.step1.message}
              enabled={settings.step1.enabled}
              onEnabled={(on) => set({ step1: { ...settings.step1, enabled: on } })}
              text={previewText(settings.step1.message.body, { host, couponCode: null, productName, language: settings.step1.message.language })}
              parts={smsOf(settings.step1.message, null).count.parts}
              image={productImage}
              stats={stepStats(1)}
              error={errors.step1}
              onEdit={() => setEditing(1)}
            />
            <Connector>
              <WaitPill>
                Wait
                <InlineSelect label="Wait before step 2" value={String(settings.wait_hours)} onChange={(v) => set({ wait_hours: Number(v) })} options={WAIT_HOURS.map((h) => ({ value: String(h), label: String(h) }))} />
                hours · only if still no order
              </WaitPill>
            </Connector>
            <StepCard
              n={2}
              when={`Step 2 · after ${settings.wait_hours} hours`}
              title={coupon ? `${settings.step2.message.channel === 'email' ? 'Email' : 'SMS'} + coupon ${coupon.code}` : settings.step2.message.channel === 'email' ? 'Email reminder' : 'SMS reminder'}
              message={settings.step2.message}
              enabled={settings.step2.enabled}
              onEnabled={(on) => set({ step2: { ...settings.step2, enabled: on } })}
              text={previewText(settings.step2.message.body, { host, couponCode: coupon?.code ?? null, productName, language: settings.step2.message.language })}
              parts={smsOf(settings.step2.message, coupon?.code ?? null).count.parts}
              image={productImage}
              stats={stepStats(2)}
              error={errors.step2}
              onEdit={() => setEditing(2)}
              extra={
                <label className="flex flex-wrap items-center gap-2 text-caption text-text-secondary">
                  Coupon
                  <select
                    value={settings.step2.coupon_id ?? ''}
                    onChange={(e) => set({ step2: { ...settings.step2, coupon_id: e.target.value || null } })}
                    className="rounded-lg border border-border-default bg-surface-card px-2 py-1.5 text-body text-text-primary outline-none focus-visible:shadow-focus"
                  >
                    <option value="">{coupons.isPending ? 'Loading…' : 'No coupon'}</option>
                    {couponList.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.code}
                      </option>
                    ))}
                  </select>
                </label>
              }
            />
            <Connector>
              <WaitPill>Stop when an order is placed</WaitPill>
            </Connector>
            <Row
              dashed
              icon={<IconBadge icon={Check} tone="success" size={40} />}
              eyebrow="Exit"
              title={
                <span className="flex flex-wrap items-center gap-1.5">
                  Order placed or
                  <InlineSelect label="Days before the flow ends" value={String(settings.exit_days)} onChange={(v) => set({ exit_days: Number(v) })} options={EXIT_DAYS.map((d) => ({ value: String(d), label: String(d) }))} className="text-body" />
                  {settings.exit_days === 1 ? 'day' : 'days'} passed
                </span>
              }
              line={coupon?.ends_at && settings.step2.enabled ? `Coupon expires automatically · no more messages` : 'No more messages'}
            />
          </div>
        </Card>

        <div className="flex w-full flex-col gap-6 lg:w-[368px] lg:shrink-0">
          <RecentCarts
            runs={runRows}
            pending={runs.isPending}
            error={runs.isError ? runs.error : null}
            onRetry={() => void runs.refetch()}
            onSeeAll={() => navigate(`/marketing/automations/runs?automation=${automation.id}`)}
          />
          <PerDay stats={stats.data} pending={stats.isPending} error={stats.isError ? stats.error : null} onRetry={() => void stats.refetch()} />
          <Rules skipRisky={settings.skip_risky} onSkipRisky={(on) => set({ skip_risky: on })} coupon={coupon} />
        </div>
      </div>

      {editing && (
        <MessageDialog
          open
          title={`Edit step ${editing} message`}
          recipe="checkout_recovery"
          message={editing === 1 ? settings.step1.message : settings.step2.message}
          couponCode={editing === 2 ? (coupon?.code ?? null) : null}
          emailNote="Email is sent only when the buyer typed an email at checkout."
          onClose={() => setEditing(null)}
          onApply={(m) => {
            if (editing === 1) set({ step1: { ...settings.step1, message: m } });
            else set({ step2: { ...settings.step2, message: m } });
            setErrors(({ [`step${editing}`]: _drop, ...rest }) => rest);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

function Kpis({ stats, pending, features }: { stats: AutomationStats | undefined; pending: boolean; features: Parameters<typeof allowanceOf>[0] }) {
  if (pending)
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-[118px] rounded-card" />
        ))}
      </div>
    );
  const k = stats?.kpis;
  const left = allowanceLeft(allowanceOf(features, 'sms'));
  const rate = k?.recovery_rate_pct;
  return (
    <section aria-label="Cart recovery summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <KpiTile icon={<ShoppingCart />} label="Carts left behind" value={k ? formatCount(k.carts_left_behind) : '—'} hint={k ? `Worth ${formatBdt(k.carts_left_behind_amount)} · last 30 days` : 'last 30 days'} />
      <KpiTile icon={<RefreshCw />} label="Recovered" value={k ? formatCount(k.recovered) : '—'} hint={rate === null || rate === undefined ? 'No recoveries yet' : `${rate.toLocaleString('en-US', { maximumFractionDigits: 1 })}% recovery rate`} />
      <KpiTile icon={<BarChart3 />} label="Revenue won back" value={k ? formatBdt(k.revenue_amount) : '—'} hint={k?.average_recovered_amount ? `Avg cart ${formatBdt(k.average_recovered_amount)}` : 'last 30 days'} />
      <KpiTile icon={<Send />} label="Messages sent" value={k ? formatCount(k.messages_sent_month) : '—'} hint={left === null ? 'this month' : `this month · ${formatCount(left)} SMS left`} />
    </section>
  );
}

/** Trigger / exit rows (dashed outline, 40px icon). */
function Row({ icon, eyebrow, title, line, dashed }: { icon: ReactNode; eyebrow: string; title: ReactNode; line: string; dashed?: boolean }) {
  return (
    <div className={cn('flex items-center gap-3 rounded-card p-4', dashed && 'border border-dashed border-border-default')}>
      {icon}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-caption text-text-muted uppercase">{eyebrow}</p>
        <div className="text-body-lg font-medium text-text-primary">{title}</div>
        <p className="text-caption text-text-secondary">{line}</p>
      </div>
    </div>
  );
}

/** Recovery/Step 71:20588. */
function StepCard({
  n,
  when,
  title,
  message,
  enabled,
  onEnabled,
  text,
  parts,
  image,
  stats,
  error,
  onEdit,
  extra,
}: {
  n: 1 | 2;
  when: string;
  title: string;
  message: AutomationMessage;
  enabled: boolean;
  onEnabled: (on: boolean) => void;
  text: string;
  parts: number;
  image: string | null;
  stats: { sent: number; recovered: number; revenue_amount: number } | undefined;
  error?: string;
  onEdit: () => void;
  extra?: ReactNode;
}) {
  const email = message.channel === 'email';
  return (
    <section aria-label={`Step ${n}`} className={cn('flex flex-col gap-4 rounded-card border border-border-default bg-surface-card p-4 shadow-elevation-1 sm:p-5', !enabled && 'opacity-70')}>
      <div className="flex items-center gap-3">
        <IconBadge icon={email ? Mail : MessageCircle} tone={email ? 'success' : 'info'} size={40} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-caption font-medium text-text-muted">{when}</p>
          <h3 className="text-body-lg font-medium text-text-primary">{title}</h3>
        </div>
        <Toggle label={`Step ${n} on`} checked={enabled} onChange={onEnabled} />
      </div>
      <div className={cn('flex items-start gap-3 rounded-lg bg-surface-subtle p-3', error && 'ring-1 ring-danger')}>
        {image ? (
          <img src={image} alt="" className="size-12 shrink-0 rounded-md object-cover" />
        ) : (
          <span aria-hidden className="flex size-12 shrink-0 items-center justify-center rounded-md bg-surface-card text-text-muted">
            <ImageOff className="size-5" />
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {email && message.subject && <p className="text-body font-medium text-text-primary">{message.subject}</p>}
          <p className={cn('break-words whitespace-pre-line text-text-primary', message.language === 'bn' ? 'font-bangla text-[16px] leading-[26px]' : 'text-body')}>{text || 'No message yet.'}</p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-caption text-text-muted" data-testid={`step-${n}-head`}>
              {email ? 'Email' : `SMS · ${parts} ${parts === 1 ? 'part' : 'parts'}`}
            </span>
            <button type="button" onClick={onEdit} className="rounded-sm text-caption font-medium text-brand-600 outline-none hover:underline focus-visible:shadow-focus">
              Edit message
            </button>
          </div>
        </div>
      </div>
      {error && (
        <p role="alert" className="-mt-2 text-caption text-danger">
          {error}
        </p>
      )}
      {extra}
      <dl className="grid grid-cols-3 gap-3">
        <Stat label="Sent" value={stats ? formatCount(stats.sent) : '—'} />
        <Stat label="Recovered" value={stats ? `${formatCount(stats.recovered)} ${stats.recovered === 1 ? 'cart' : 'carts'}` : '—'} />
        <Stat label="Revenue" value={stats ? formatBdt(stats.revenue_amount) : '—'} />
      </dl>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-caption text-text-muted">{label}</dt>
      <dd className="truncate text-body-lg font-medium text-text-primary">{value}</dd>
    </div>
  );
}

function RecentCarts({ runs, pending, error, onRetry, onSeeAll }: { runs: AutomationRun[]; pending: boolean; error: unknown; onRetry: () => void; onSeeAll: () => void }) {
  const rows = runs.slice(0, 5);
  return (
    <Card
      title="Recent carts"
      subtitle="Live · updates every minute"
      className="gap-1"
      action={
        <button type="button" onClick={onSeeAll} className="shrink-0 text-caption font-medium text-brand-600 outline-none hover:underline focus-visible:shadow-focus">
          See all →
        </button>
      }
    >
      {pending ? (
        <LoadingRows rows={3} label="Loading carts" />
      ) : error ? (
        <ErrorBlock title="We couldn’t load carts" error={error} onRetry={onRetry} />
      ) : rows.length === 0 ? (
        <p className="py-3 text-body text-text-secondary">No unfinished checkouts yet. They show up here when a buyer leaves after typing their phone.</p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((r) => {
            const p = recoveryPill(r);
            return (
              <li key={r.id} className="flex items-center gap-3 border-t border-border-default py-3 first:border-t-0">
                {r.context.first_product_image_url ? (
                  <img src={r.context.first_product_image_url} alt="" className="size-11 shrink-0 rounded-md object-cover" />
                ) : (
                  <span aria-hidden className="flex size-11 shrink-0 items-center justify-center rounded-md bg-surface-subtle text-text-muted">
                    <ShoppingCart className="size-4" />
                  </span>
                )}
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <p className="truncate text-body font-medium text-text-primary">{r.contact?.name ?? 'Customer'}</p>
                  <p className="truncate text-caption text-text-secondary">{cartLine(r)}</p>
                </div>
                <Badge tone={p.tone} dot className="shrink-0">
                  {p.label}
                </Badge>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function PerDay({ stats, pending, error, onRetry }: { stats: AutomationStats | undefined; pending: boolean; error: unknown; onRetry: () => void }) {
  const bars: BarDatum[] = (stats?.daily ?? []).map((d) => ({ label: shortDate(`${d.date}T06:00:00Z`), value: d.recovered }));
  return (
    <Card title="Recovered per day" subtitle="Last 14 days" className="gap-4">
      {pending ? (
        <Skeleton className="h-24 rounded-lg" />
      ) : error ? (
        <ErrorBlock title="We couldn’t load the chart" error={error} onRetry={onRetry} />
      ) : bars.every((b) => b.value === 0) ? (
        <p className="text-body text-text-secondary">No carts recovered in the last 14 days.</p>
      ) : (
        <BarChart caption="Carts recovered per day, last 14 days" bars={bars} height={96} axis={false} maxXLabels={2} formatValue={(n) => `${formatCount(n)} recovered`} />
      )}
    </Card>
  );
}

function Rules({ skipRisky, onSkipRisky, coupon }: { skipRisky: boolean; onSkipRisky: (on: boolean) => void; coupon: Coupon | null }) {
  const onePerPhone = coupon?.usage_per_customer === 1;
  return (
    <Card title="Rules" className="gap-4">
      <ul className="flex flex-col gap-4 pt-3">
        <RuleRow title="Skip Risky customers" text="Don’t send reminders to buyers who return most parcels.">
          <Toggle label="Skip Risky customers" checked={skipRisky} onChange={onSkipRisky} />
        </RuleRow>
        <RuleRow title="Quiet hours" text="No messages 9 PM – 9 AM">
          <Toggle label="Quiet hours" checked disabled />
        </RuleRow>
        <RuleRow
          title="One coupon per phone"
          text={
            !coupon ? (
              'Only applies when step 2 has a coupon.'
            ) : onePerPhone ? (
              `${coupon.code} works once per number`
            ) : (
              <>
                Set uses per customer to 1 on{' '}
                <Link to={`/marketing/coupons/${coupon.id}`} className="font-medium text-brand-600 hover:underline">
                  {coupon.code}
                </Link>
              </>
            )
          }
        >
          <Toggle label="One coupon per phone" checked={onePerPhone} disabled />
        </RuleRow>
      </ul>
    </Card>
  );
}

function RuleRow({ title, text, children }: { title: string; text: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-center gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-body font-medium text-text-primary">{title}</p>
        <p className="text-caption text-text-muted">{text}</p>
      </div>
      {children}
    </li>
  );
}

export default CheckoutRecoveryPage;
