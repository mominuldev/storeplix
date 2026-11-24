import { isApiError } from '@storeplix/api-client';
import type { FraudGuardOverview, FraudGuardSettings, UpdateFraudGuardSettingsInput } from '@storeplix/types';
import { Badge, Button, cn, EmptyState, formatBdt, Select, Skeleton, Toggle } from '@storeplix/ui';
import { CreditCard, MessageCircle, Phone, RefreshCw, Shield, ShieldCheck, ShoppingBag, Users } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, errorMessage, LoadingRows } from '../catalog/states';
import { SearchBox, useDebounced } from '../catalog/ui';
import { useReadOnly } from '../impersonation/hooks';
import { ReadOnlyActions } from '../impersonation/ReadOnlyActions';
import { PageHeader } from '../layout/PageHeader';
import { toast } from '../online-store/components/Toast';
import { linkGateways } from '../payments/gateways';
import { usePaymentGateways } from '../payments/queries';
import { useFeatures } from '../plan/useFeatures';
import { BlockedTable, DecisionList, GuardCard, GuardPlanNote, PrivacyNote } from './components';
import { BlockNumberDialog, CheckNumberDialog } from './dialogs';
import { guardLocked, heroLine, ruleOptions, RULES, rulesOn, stoppedSplit, type RuleDef, type RuleKey } from './fraud';
import { useBlockedNumbers, useGuardEvents, useGuardOverview, useGuardSettings, useResetGuardSettings, useUpdateGuardSettings } from './queries';

// PHASE-8-8 §10.1 Fake order guard — section 41:12365, frame 39:11233. Header 41:11440 (+ Tag Protection on/off,
// Check a number / Block a number → composed dialogs), Shield hero 41:11448 with "n of 6 rules on · checking your own
// orders" and KPIs 41:11456 / 41:11461 / Advance collected (composed for "Delivery charges saved" 41:11466, Q191);
// Rules 41:11470 (six built; "Check courier record" and "Block VPN and proxy" hidden, P88-7 / Q190) with autosave and
// "Reset to recommended"; Blocked numbers 41:11630 (+ composed /orders/fraud-guard/blocked); Recent decisions 41:11740
// (+ composed /orders/fraud-guard/log); privacy note 41:11808. Below lg: rule cards 1-up, tables become cards (§10.5).

const RECENT = 5;

const ruleIcon: Record<RuleKey, ReactNode> = {
  hold: <Phone aria-hidden />,
  advance: <CreditCard aria-hidden />,
  otp: <MessageCircle aria-hidden />,
  returners: <RefreshCw aria-hidden />,
  duplicates: <ShoppingBag aria-hidden />,
  limit: <Users aria-hidden />,
};

export default function FraudGuardPage() {
  const scope = useStoreScope();
  const features = useFeatures();
  const locked = guardLocked(features.data);
  const readOnly = useReadOnly();
  const settings = useGuardSettings();
  const overview = useGuardOverview();
  const [dialog, setDialog] = useState<{ kind: 'check' } | { kind: 'block'; phone?: string } | null>(null);
  const s = settings.data;
  const protectedOn = !!s && s.enabled && !locked && rulesOn(s) > 0;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2.5">
            Fake order guard
            {s && (
              <Badge size="sm" tone={protectedOn ? 'success' : 'neutral'}>
                {protectedOn ? 'Protection on' : 'Protection off'}
              </Badge>
            )}
          </span>
        }
        subtitle="Stops fake and risky cash-on-delivery orders before you pay to ship them."
        actions={
          <>
            <Button variant="secondary" disabled={locked} onClick={() => setDialog({ kind: 'check' })}>
              Check a number
            </Button>
            <Button disabled={locked} onClick={() => setDialog({ kind: 'block' })}>
              Block a number
            </Button>
          </>
        }
      />
      {locked && <GuardPlanNote canSeePlans={scope.canViewBilling} />}

      {settings.isPending ? (
        <HeroLoading />
      ) : settings.isError ? (
        <GuardCard label="Fake order guard">
          <ErrorBlock error={settings.error} title="We couldn’t load the guard" onRetry={() => void settings.refetch()} />
        </GuardCard>
      ) : (
        <>
          <Hero settings={settings.data} overview={overview.data} on={protectedOn} />
          <Rules settings={settings.data} disabled={locked || readOnly} />
        </>
      )}

      <div className="flex flex-col gap-5 lg:grid lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start">
        <BlockedCard canWrite={!locked} />
        <div className="flex flex-col gap-5">
          <RecentDecisions />
          <PrivacyNote />
        </div>
      </div>

      {dialog?.kind === 'check' && <CheckNumberDialog onClose={() => setDialog(null)} onBlock={(phone) => setDialog({ kind: 'block', phone })} />}
      {dialog?.kind === 'block' && <BlockNumberDialog initialPhone={dialog.phone} onClose={() => setDialog(null)} />}
    </div>
  );
}

function HeroLoading() {
  return (
    <div role="status" aria-label="Loading the guard" className="flex flex-col gap-5">
      <Skeleton className="h-[124px] w-full rounded-card" />
      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-36 rounded-card" />
        ))}
      </div>
    </div>
  );
}

/** Shield hero 41:11448 (brand-600, white text): title + rules line, then three KPIs split by 1px rules. */
function Hero({ settings, overview, on }: { settings: FraudGuardSettings; overview: FraudGuardOverview | undefined; on: boolean }) {
  const stopped = overview ? stoppedSplit(overview) : null;
  const n = (v: number | undefined) => (v === undefined ? '—' : v.toLocaleString('en-IN'));
  return (
    <section aria-label="Protection" className="flex flex-col gap-5 rounded-card bg-brand-600 px-5 py-6 text-text-inverse shadow-elevation-1 lg:flex-row lg:items-center lg:gap-6 lg:px-7 lg:py-[26px]">
      <div className="flex items-center gap-4 lg:w-[360px] lg:shrink-0 lg:gap-6">
        <span className="flex size-16 shrink-0 items-center justify-center rounded-[18px] bg-surface-card/15">
          {on ? <ShieldCheck aria-hidden className="size-8" /> : <Shield aria-hidden className="size-8" />}
        </span>
        <div className="flex min-w-0 flex-col gap-1.5">
          <h2 className="text-heading-24">{on ? 'Your shop is protected' : 'Protection is off'}</h2>
          <p className="text-body">{heroLine(on ? rulesOn(settings) : 0)}</p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 lg:flex lg:flex-1 lg:gap-6">
        <Kpi label="Orders protected this month" value={n(overview?.orders_checked)} hint="Every new order checked" />
        <Kpi label="Fake orders stopped" value={stopped ? n(stopped.total) : '—'} hint={stopped?.text ?? ' '} />
        <Kpi label="Advance collected" value={overview ? formatBdt(overview.advance_collected_amount) : '—'} hint="Paid before shipping this month" />
      </div>
    </section>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 lg:flex-1 lg:border-l lg:border-surface-card/25 lg:pl-6">
      <span className="text-body font-medium opacity-85">{label}</span>
      <span className="text-[32px] leading-10 font-bold whitespace-nowrap lg:text-display">{value}</span>
      <span className="text-caption opacity-75">{hint}</span>
    </div>
  );
}

/** Rules 41:11470: header + Reset to recommended, six cards with a toggle and one setting row; autosave per change. */
function Rules({ settings, disabled }: { settings: FraudGuardSettings; disabled: boolean }) {
  const update = useUpdateGuardSettings();
  const reset = useResetGuardSettings();
  const gateways = usePaymentGateways();
  const noGateway = gateways.isSuccess && linkGateways(gateways.data).length === 0;
  const save = (input: UpdateFraudGuardSettingsInput) =>
    update.mutate(input, {
      onSuccess: () => toast('Saved. Applies to new orders.'),
      onError: (e) => toast(isApiError(e) && e.code === 'feature_not_in_plan' ? 'Fake order guard is on Starter and Growth.' : errorMessage(e, 'We couldn’t save this rule.'), 'error'),
    });
  return (
    <section aria-label="Rules" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="text-heading text-text-primary">Rules</h2>
          <p className="text-body text-text-secondary">Run on every new order before it reaches your list. Changes apply right away.</p>
        </div>
        <ReadOnlyActions>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            loading={reset.isPending}
            onClick={() =>
              reset.mutate(undefined, {
                onSuccess: () => toast('Rules reset to recommended.'),
                onError: (e) => toast(errorMessage(e, 'We couldn’t reset the rules.'), 'error'),
              })
            }
          >
            Reset to recommended
          </Button>
        </ReadOnlyActions>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {RULES.map((r) => (
          <RuleCard
            key={r.key}
            rule={r}
            settings={settings}
            disabled={disabled || !settings.enabled}
            note={r.key === 'advance' && noGateway ? 'No payment gateway is connected, so these orders are held for a call instead. Connect bKash or SSLCommerz in Integrations.' : r.key === 'otp' ? 'Uses SMS credits' : null}
            onChange={save}
          />
        ))}
      </div>
    </section>
  );
}

function RuleCard({ rule, settings, disabled, note, onChange }: { rule: RuleDef; settings: FraudGuardSettings; disabled: boolean; note: string | null; onChange: (input: UpdateFraudGuardSettingsInput) => void }) {
  const on = settings[rule.toggle];
  const field = rule.setting.field;
  return (
    <article aria-label={rule.title} className="flex flex-col gap-4 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-subtle text-text-secondary [&_svg]:size-4">{ruleIcon[rule.key]}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h3 className="text-body-lg font-medium text-text-primary">{rule.title}</h3>
          <p className="text-body text-text-secondary">{rule.text}</p>
          {note && <p className="text-caption text-text-muted">{note}</p>}
        </div>
        <Toggle label={rule.title} checked={on} disabled={disabled} onChange={(v) => onChange({ [rule.toggle]: v })} />
      </div>
      <div className={cn('flex items-center gap-3 rounded-lg bg-surface-subtle px-3 py-2', !on && 'opacity-60')}>
        <span className="min-w-0 flex-1 text-body text-text-primary">{rule.setting.label}</span>
        {field ? (
          <Select
            aria-label={rule.setting.label}
            value={String(settings[field])}
            disabled={disabled || !on}
            onChange={(e) => onChange({ [field]: Number(e.target.value) })}
            containerClassName="shrink-0"
            className="h-9 rounded-md bg-surface-card pl-3 font-medium"
          >
            {ruleOptions(field, settings).map((v) => (
              <option key={v} value={v}>
                {rule.setting.unit(v)}
              </option>
            ))}
          </Select>
        ) : (
          <span className="rounded-md bg-surface-card px-3 py-1.5 text-body font-medium text-text-primary">{rule.setting.fixed}</span>
        )}
      </div>
    </article>
  );
}

function BlockedCard({ canWrite }: { canWrite: boolean }) {
  const [q, setQ] = useState('');
  const debounced = useDebounced(q.replace(/\D/g, ''));
  const overview = useGuardOverview();
  const list = useBlockedNumbers(debounced, 'recent');
  const rows = (list.data?.pages[0]?.data ?? []).slice(0, RECENT);
  const total = overview.data?.blocked_count;
  return (
    <GuardCard label="Blocked numbers">
      <div className="flex flex-col gap-3 p-5 pb-4 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-body-lg font-medium text-text-primary">Blocked numbers{total !== undefined ? ` · ${total}` : ''}</h2>
          <p className="text-caption text-text-secondary">Cash on delivery is off for these numbers. They can still pay online.</p>
        </div>
        <SearchBox value={q} onChange={setQ} placeholder="Search number" label="Search blocked numbers" className="h-9 w-full rounded-md border border-border-default sm:w-[180px]" />
      </div>
      {list.isPending ? (
        <LoadingRows rows={4} label="Loading blocked numbers" />
      ) : list.isError ? (
        <ErrorBlock error={list.error} title="We couldn’t load blocked numbers" onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        <p className="border-t border-border-default px-5 py-8 text-center text-body text-text-muted">{debounced ? `No blocked number ends in ${debounced}.` : 'No blocked numbers yet.'}</p>
      ) : (
        <BlockedTable rows={rows} canWrite={canWrite} dim={list.isPlaceholderData} />
      )}
      <div className="flex items-center gap-3 border-t border-border-default px-5 py-3 text-caption text-text-muted">
        <span className="min-w-0 flex-1">{total !== undefined && rows.length > 0 ? `Showing ${rows.length} of ${total}` : ''}</span>
        <Link to="/orders/fraud-guard/blocked" className="text-body font-medium text-brand-600 hover:text-brand-700">
          View all blocked numbers
        </Link>
      </div>
    </GuardCard>
  );
}

function RecentDecisions() {
  const events = useGuardEvents('recent');
  const rows = (events.data?.pages[0]?.data ?? []).slice(0, RECENT);
  return (
    <GuardCard label="Recent decisions" className="gap-1 p-5">
      <div className="flex items-center gap-2 pb-2">
        <h2 className="min-w-0 flex-1 text-body-lg font-medium text-text-primary">Recent decisions</h2>
        <Link to="/orders/fraud-guard/log" className="text-body font-medium text-brand-600 hover:text-brand-700">
          View all
        </Link>
      </div>
      {events.isPending ? (
        <LoadingRows rows={4} label="Loading decisions" />
      ) : events.isError ? (
        <ErrorBlock error={events.error} title="We couldn’t load decisions" onRetry={() => void events.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState icon={<ShieldCheck />} title="No decisions yet — new orders will appear here." className="py-6" />
      ) : (
        <DecisionList events={rows} />
      )}
    </GuardCard>
  );
}
