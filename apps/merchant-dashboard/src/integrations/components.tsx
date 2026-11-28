import type { IntegrationCheck, IntegrationCheckState, StoreIntegration } from '@storeplix/types';
import { Badge, Button, buttonVariants, cn, CopyField, Dialog, Input, Tabs, type BadgeTone } from '@storeplix/ui';
import { AlertTriangle, Check, ChevronRight, Clock, ExternalLink, Info, Lock, ShieldCheck, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { timeAgo } from '../commerce/format';
import { toast } from '../online-store/components/Toast';
import { formatDate } from '../plan/billing';
import { Panel } from '../sms/components';
import ga4Logo from './assets/ga4.svg';
import gtmLogo from './assets/gtm.svg';
import metaLogo from './assets/meta.svg';
import tiktokLogo from './assets/tiktok.svg';
import { featureName, featurePlan, integrationErrorText, maskedHint, PROVIDER_META, statusMeta, type PartAProvider } from './integrations';
import { useDisconnect, useVerify } from './queries';

// PHASE-8-9D §8 shared pieces of the integration detail shell (Figma 28:2152 / 2132:53511): logo tile, breadcrumb,
// header card, tabs, cards, setting rows, write-only secret field (P89D-7), connection check, typed DISCONNECT dialog
// (2135:55831), plan upgrade state and banners. Tokens only.

export { Panel };

const LOGOS: Partial<Record<PartAProvider, string>> = { meta_pixel: metaLogo, meta_catalog: metaLogo, ga4: ga4Logo, tiktok_pixel: tiktokLogo, gtm_server: gtmLogo };

/** Logo tile: 64 px in the header (radius 16), 40 px on list cards (radius 10). Google Merchant is a "G" text tile. */
export function ProviderTile({ provider, size = 'lg', className }: { provider: PartAProvider; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const box = size === 'lg' ? 'size-12 rounded-card sm:size-16' : size === 'md' ? 'size-10 rounded-control' : 'size-8 rounded-control';
  const logo = LOGOS[provider];
  if (!logo) {
    return (
      <span aria-hidden className={cn('flex shrink-0 items-center justify-center bg-brand-600 font-semibold text-text-inverse', box, size === 'lg' ? 'text-heading' : 'text-body', className)}>
        G
      </span>
    );
  }
  return (
    <span aria-hidden className={cn('flex shrink-0 items-center justify-center border border-border-default bg-surface-card', box, className)}>
      <img alt="" src={logo} className={size === 'lg' ? 'size-6 sm:size-8' : size === 'md' ? 'size-6' : 'size-5'} />
    </span>
  );
}

export function Breadcrumb({ provider }: { provider: PartAProvider }) {
  const meta = PROVIDER_META[provider];
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-body font-medium">
      <Link to="/integrations" className="text-brand-600 hover:underline">
        Integrations
      </Link>
      <ChevronRight aria-hidden className="size-3.5 text-text-muted" />
      <Link to={`/integrations?filter=${meta.groupFilter}`} className="text-brand-600 hover:underline">
        {meta.group}
      </Link>
      <ChevronRight aria-hidden className="size-3.5 text-text-muted" />
      <span aria-current="page" className="text-text-secondary">
        {meta.name}
      </span>
    </nav>
  );
}

export interface HeaderMetaItem {
  icon: 'check' | 'clock' | 'shield';
  text: string;
}
const META_ICONS = { check: Check, clock: Clock, shield: ShieldCheck } as const;

/** Header card: logo tile, title, status + type pills, description, meta line, actions and the red Disconnect link. */
export function IntegrationHeader({
  provider,
  status,
  meta,
  primary,
  onDisconnect,
}: {
  provider: PartAProvider;
  status: StoreIntegration['status'];
  meta: HeaderMetaItem[];
  primary?: ReactNode;
  onDisconnect?: () => void;
}) {
  const info = PROVIDER_META[provider];
  const s = statusMeta(status);
  return (
    <section aria-label={info.name} className="flex flex-col gap-4 rounded-card border border-border-default bg-surface-card px-4 py-[18px] shadow-elevation-1 lg:flex-row lg:items-center lg:gap-5 lg:px-6 lg:py-[22px]">
      <div className="flex min-w-0 flex-1 items-start gap-4 lg:items-center lg:gap-5">
        <ProviderTile provider={provider} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-heading-24 font-semibold text-text-primary">{info.name}</h1>
            <Badge tone={s.tone} dot={s.tone === 'success'} size="sm">
              {s.label}
            </Badge>
            <Badge tone={provider === 'gtm_server' ? 'info' : 'neutral'} size="sm">
              {info.typePill}
            </Badge>
          </div>
          <p className="text-body text-text-secondary">{info.description}</p>
          {meta.length > 0 && (
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-text-secondary">
              {meta.map((m) => {
                const Icon = META_ICONS[m.icon];
                return (
                  <li key={m.text} className="flex items-center gap-1.5">
                    <Icon aria-hidden className="size-3.5 text-text-muted" />
                    {m.text}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-2 lg:shrink-0 lg:items-end">
        <div className="flex flex-col gap-2 sm:flex-row">
          <a href={info.externalUrl} target="_blank" rel="noreferrer noopener" className={buttonVariants({ variant: 'secondary' })}>
            {info.externalLabel}
          </a>
          {primary}
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

/** Header meta items: "Connected {date} by {name}", last check, plus a provider-specific item. */
export function connectedMeta(row: StoreIntegration | undefined, extra: HeaderMetaItem[] = []): HeaderMetaItem[] {
  if (!row?.connected_at) return extra;
  const items: HeaderMetaItem[] = [{ icon: 'check', text: `Connected ${formatDate(row.connected_at)}${row.connected_by ? ` by ${row.connected_by.name.split(' ')[0]}` : ''}` }];
  if (row.last_verified_at) items.push({ icon: 'clock', text: `Last checked ${timeAgo(row.last_verified_at)}` });
  return [...items, ...extra];
}

export function DetailTabs<T extends string>({ label, value, items, onChange }: { label: string; value: T; items: { value: T; label: string; count?: number | null }[]; onChange: (t: T) => void }) {
  return <Tabs aria-label={label} value={value} onChange={onChange} items={items} />;
}

/** Two columns on desktop (760 + 340), stacked below `lg`. */
export function Columns({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-5">{left}</div>
      <div className="flex flex-col gap-5 lg:w-[340px] lg:shrink-0">{right}</div>
    </div>
  );
}

export function Banner({ tone, children, icon, action }: { tone: 'success' | 'warning' | 'danger' | 'info'; children: ReactNode; icon?: ReactNode; action?: ReactNode }) {
  const tones = {
    success: 'bg-success-bg text-success',
    warning: 'bg-warning-bg text-warning',
    danger: 'bg-danger-bg text-danger',
    info: 'bg-info-bg text-info',
  } as const;
  const Icon = tone === 'success' ? Check : tone === 'info' ? Info : AlertTriangle;
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cn('flex items-start gap-2.5 rounded-control px-3.5 py-2.5 text-body font-medium', tones[tone])}>
      <span aria-hidden className="mt-0.5 shrink-0 [&_svg]:size-4">
        {icon ?? <Icon />}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}

export function Tip({ title, children }: { title: string; children: ReactNode }) {
  return (
    <aside aria-label={title} className="flex flex-col gap-2 rounded-card border border-brand-100 bg-brand-50 px-6 py-[22px]">
      <h2 className="text-body-lg font-medium text-text-primary">{title}</h2>
      <p className="text-caption text-text-secondary">{children}</p>
    </aside>
  );
}

/** Settings row: title + caption, control on the right; divided list inside a card. */
export function SettingRow({ title, description, control, id }: { title: string; description?: ReactNode; control: ReactNode; id?: string }) {
  return (
    <div className="flex flex-col gap-3 border-b border-border-default py-3.5 last:border-b-0 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p id={id} className="text-body font-semibold text-text-primary">
          {title}
        </p>
        {description && <p className="text-caption text-text-secondary">{description}</p>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

export function ReadOnlyField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <span className="text-caption font-medium text-text-secondary">{label}</span>
      <div className="flex min-h-11 items-center rounded-control border border-border-default bg-surface-canvas px-3 py-2.5 text-body text-text-primary">{value}</div>
    </div>
  );
}

export function CopyRow({ label, value }: { label: string; value: string }) {
  return <CopyField label={label} value={value} className="min-w-0 flex-1" onCopied={() => toast(`${label} copied`)} />;
}

/**
 * Write-only secret (P89D-7, FIGMA part 2): lock, `••••` + last 4 from the hint and a **Replace** link (never Show or
 * Copy). Replace opens an empty paste field; the stored value keeps working until the new one is saved.
 */
export function WriteOnlySecret({
  label,
  hint,
  updatedAt,
  canReplace,
  saving,
  error,
  validate,
  onSave,
}: {
  label: string;
  hint: string | undefined;
  updatedAt: string | null;
  canReplace: boolean;
  saving: boolean;
  error: string | null;
  validate: (v: string) => string | null;
  onSave: (value: string, done: () => void) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);
  const masked = maskedHint(hint);
  const problem = touched ? validate(value) : null;
  if (editing) {
    return (
      <form
        className="flex min-w-0 flex-1 flex-col gap-2"
        aria-label={`Replace ${label}`}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (validate(value)) return;
          onSave(value.trim(), () => {
            setEditing(false);
            setValue('');
            setTouched(false);
          });
        }}
      >
        <Input
          label={`New ${label.charAt(0).toLowerCase()}${label.slice(1)}`}
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => setTouched(true)}
          placeholder={`Paste the new ${label.toLowerCase()}`}
          error={problem ?? error ?? undefined}
          hint="The current one keeps working until you save."
        />
        <div className="flex gap-2">
          <Button type="submit" size="sm" loading={saving}>
            Save
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              setEditing(false);
              setValue('');
              setTouched(false);
            }}
          >
            Cancel
          </Button>
        </div>
      </form>
    );
  }
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <span className="text-caption font-medium text-text-secondary">{label}</span>
      <div className="flex min-h-11 items-center gap-2 rounded-control border border-border-default bg-surface-canvas px-3 py-2.5">
        <Lock aria-hidden className="size-3.5 shrink-0 text-text-muted" />
        <span className="min-w-0 flex-1 truncate text-body text-text-primary" aria-label={masked ? `${label} ending ${masked.slice(-4)}` : `${label} not set`}>
          {masked ? `••••••••••${masked.slice(-4)}` : 'Not set'}
        </span>
        {canReplace && (
          <button type="button" onClick={() => setEditing(true)} className="shrink-0 rounded-sm text-caption font-medium text-brand-600 outline-none hover:underline focus-visible:shadow-focus" aria-label={`Replace ${label}`}>
            Replace
          </button>
        )}
      </div>
      <p className="text-caption text-text-secondary">Write-only, last 4 shown{updatedAt ? ` · replaced ${formatDate(updatedAt)}` : ''}</p>
    </div>
  );
}

const CHECK_TONE: Record<IntegrationCheckState, string> = { ok: 'text-success', warn: 'text-warning', fail: 'text-danger', skipped: 'text-text-muted' };
const CHECK_LABEL: Record<IntegrationCheckState, string> = { ok: 'OK', warn: 'Check', fail: 'Failed', skipped: 'Not checked' };

export function CheckRow({ label, state, detail }: { label: string; state: IntegrationCheckState; detail?: string | null }) {
  const Icon = state === 'ok' ? Check : state === 'skipped' ? Clock : state === 'fail' ? X : AlertTriangle;
  return (
    <li className="flex items-center gap-2">
      <Icon aria-hidden className={cn('size-3.5 shrink-0', state === 'ok' ? 'text-text-secondary' : CHECK_TONE[state])} />
      <span className="min-w-0 flex-1 text-body text-text-secondary">{label}</span>
      <span className={cn('shrink-0 text-caption', CHECK_TONE[state])}>{detail || CHECK_LABEL[state]}</span>
    </li>
  );
}

/** Right-column "Connection check" (§4.5): runs POST …/verify on demand; read-only members see the last result only. */
export function ConnectionCheckCard({ provider, canRun }: { provider: PartAProvider; canRun: boolean }) {
  const verify = useVerify(provider);
  const [result, setResult] = useState<IntegrationCheck | null>(null);
  const verified = result ? (result.ok ? { label: 'Verified', tone: 'success' as BadgeTone } : { label: 'Needs a fix', tone: 'danger' as BadgeTone }) : null;
  return (
    <Panel
      title="Connection check"
      actions={
        verified ? (
          <Badge tone={verified.tone} size="sm">
            {verified.label}
          </Badge>
        ) : undefined
      }
    >
      {result ? (
        <ul className="flex flex-col gap-3" aria-label="Check results">
          {result.rows.map((r) => (
            <CheckRow key={r.key} label={r.label} state={r.state} detail={r.detail} />
          ))}
          {result.found_name && <CheckRow label={`Found · ${result.found_name}`} state="ok" />}
        </ul>
      ) : (
        <p className="text-caption text-text-secondary">Check the ID and token with {PROVIDER_META[provider].short} now.</p>
      )}
      {verify.error ? (
        <p role="alert" className="text-caption text-danger">
          {integrationErrorText(verify.error, provider)}
        </p>
      ) : null}
      {canRun && (
        <Button size="sm" variant="secondary" className="self-start" loading={verify.isPending} onClick={() => verify.mutate(undefined, { onSuccess: setResult })}>
          {result ? 'Check again' : 'Run check'}
        </Button>
      )}
    </Panel>
  );
}

/** Typed DISCONNECT (Figma 2135:55831, P89D-31), the same dialog for every integration in this phase. */
export function DisconnectDialog({ provider, stops, keepNote, onClose, onDone }: { provider: PartAProvider; stops: string[]; keepNote: string; onClose: () => void; onDone?: () => void }) {
  const [typed, setTyped] = useState('');
  const disconnect = useDisconnect(provider);
  const ok = typed === 'DISCONNECT';
  return (
    <Dialog
      open
      size="sm"
      tone="danger"
      icon={<AlertTriangle />}
      title={`Disconnect ${PROVIDER_META[provider].name}?`}
      description={`${keepNote} Storeplix deletes its access and stops:`}
      confirmLabel="Disconnect"
      cancelLabel="Keep connected"
      confirmDisabled={!ok}
      loading={disconnect.isPending}
      onCancel={() => !disconnect.isPending && onClose()}
      onConfirm={() =>
        ok &&
        disconnect.mutate(undefined, {
          onSuccess: () => {
            toast(`${PROVIDER_META[provider].name} disconnected`);
            onDone?.();
            onClose();
          },
        })
      }
    >
      <div className="flex flex-col gap-4">
        <ul className="flex flex-col gap-2 rounded-lg bg-surface-canvas px-4 py-3">
          {stops.map((s) => (
            <li key={s} className="flex items-start gap-2 text-body text-text-primary">
              <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-danger" />
              {s}
            </li>
          ))}
        </ul>
        <Input label="Type DISCONNECT to confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
        {disconnect.error ? (
          <p role="alert" className="text-caption text-danger">
            {integrationErrorText(disconnect.error, provider)}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/** Plan gate (P89D-40): `product_feeds` / `server_side_tagging` not in the current plan. */
export function UpgradeState({ feature, canSeePlans }: { feature: 'product_feeds' | 'server_side_tagging'; canSeePlans: boolean }) {
  return (
    <Panel label="Upgrade">
      <div className="flex flex-col items-center gap-3 px-2 py-8 text-center">
        <span aria-hidden className="flex size-12 items-center justify-center rounded-full bg-brand-50 text-brand-600">
          <Lock className="size-6" />
        </span>
        <h2 className="text-body-lg font-medium text-text-primary">{featureName[feature]} is on the {featurePlan[feature]} plan</h2>
        <p className="max-w-md text-body text-text-secondary">
          {feature === 'product_feeds'
            ? 'Sync your products to Facebook, Instagram and Google with price and stock kept up to date. Upgrade to connect.'
            : 'Forward shop events to your own server-side Tag Manager container. Upgrade to connect.'}
        </p>
        {canSeePlans ? (
          <Link to="/settings/plan" className={buttonVariants({})}>
            See plans
          </Link>
        ) : (
          <p className="text-caption text-text-muted">Ask your shop owner to upgrade.</p>
        )}
      </div>
    </Panel>
  );
}

/** Downgraded while connected: reads stay, sending/sync pause (P89D-40). */
export function PausedBanner({ feature, canSeePlans }: { feature: 'product_feeds' | 'server_side_tagging'; canSeePlans: boolean }) {
  return (
    <Banner
      tone="warning"
      action={
        canSeePlans ? (
          <Link to="/settings/plan" className="shrink-0 font-semibold underline">
            Upgrade
          </Link>
        ) : undefined
      }
    >
      Paused — {featureName[feature]} isn’t in your plan any more. Nothing is sent until you upgrade to {featurePlan[feature]}.
    </Banner>
  );
}

export function ExternalHint({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 rounded-sm text-body font-medium text-brand-600 outline-none hover:underline focus-visible:shadow-focus">
      {children}
      <ExternalLink aria-hidden className="size-3.5" />
    </a>
  );
}

/** Table head row in the Figma table style (caption, muted, canvas fill). */
export function TableHead({ cols }: { cols: { label: string; className?: string }[] }) {
  return (
    <thead className="bg-surface-canvas">
      <tr>
        {cols.map((c) => (
          <th key={c.label} scope="col" className={cn('px-3 py-2 text-left text-caption font-medium uppercase text-text-muted first:pl-6 last:pr-6', c.className)}>
            {c.label}
          </th>
        ))}
      </tr>
    </thead>
  );
}

export const tdClass = 'border-t border-border-default px-3 py-2.5 text-body text-text-secondary first:pl-6 last:pr-6';

/** Card with a table that scrolls sideways on narrow screens. */
export function TableCard({ title, description, action, children, label }: { title: ReactNode; description?: ReactNode; action?: ReactNode; children: ReactNode; label?: string }) {
  return (
    <section aria-label={label ?? (typeof title === 'string' ? title : undefined)} className="flex flex-col overflow-hidden rounded-card border border-border-default bg-surface-card shadow-elevation-1">
      <div className="flex flex-wrap items-center gap-3 px-4 py-4 sm:px-6">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-body-lg font-medium text-text-primary">{title}</h2>
          {description && <p className="text-caption text-text-secondary">{description}</p>}
        </div>
        {action}
      </div>
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}
