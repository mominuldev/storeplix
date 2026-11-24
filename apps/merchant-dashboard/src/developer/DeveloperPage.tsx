import { buttonVariants } from '@storeplix/ui';
import { ExternalLink, FileText, Lock, ShieldCheck } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { DEVELOPER_LIMITS } from '@storeplix/types';
import { useAuth } from '../auth/AuthProvider';
import { PageHeader } from '../layout/PageHeader';
import { can } from '../lib/permissions';
import { DEVELOPER_DOCS_URL } from '../lib/links';
import { useFeatures } from '../plan/useFeatures';
import { ApiKeysCard } from './ApiKeysCard';
import { CreateKeyModal } from './CreateKeyModal';
import { DeliveriesDrawer } from './DeliveriesDrawer';
import { planNote } from './developer';
import { useApiScopes, useEventTypes, useWebhookEndpoints } from './queries';
import { RecentDeliveriesCard } from './RecentDeliveriesCard';
import { SigningSecretCard } from './SigningSecretCard';
import { DevCard } from './ui';
import { WebhooksCard } from './WebhooksCard';

// Figma Merchant / Integrations – Developer 144:40726 (PHASE-8-4 §7). Header (title, subtitle, "API docs" when a docs
// URL is configured, "+ Create API key"), plan note 144:41323, left column API keys 144:41332 + Webhooks 144:41424, right
// column (360) Signing secret 144:41521, Recent deliveries 144:41536, Build with Storeplix 144:41574. Columns stack
// below `lg`; tables scroll inside their cards (Q137). Postman row hidden (Q134). The route is gated on
// `developers.manage` (App.tsx); without `api_webhooks` every create/edit action is disabled (P84-13).

export function DeveloperPage() {
  const { activeTenant } = useAuth();
  const features = useFeatures();
  const note = planNote(features.data);
  // Until /features answers, keep writes off rather than flash enabled buttons.
  const locked = !features.data || note?.kind === 'locked';
  const scopes = useApiScopes();
  const eventTypes = useEventTypes();
  const endpoints = useWebhookEndpoints();
  // Integrations banner "Create API key" → `?create=key` opens the modal once the plan allows it.
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const wantsCreate = params.get('create') === 'key';
  const createOpen = creating || (wantsCreate && !locked);
  const closeCreate = () => {
    setCreating(false);
    if (wantsCreate)
      setParams(
        (p) => {
          p.delete('create');
          return p;
        },
        { replace: true },
      );
  };
  const [log, setLog] = useState<{ id: string | null } | null>(null);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Developer · API & webhooks"
        subtitle="Connect your own tools — accounting, warehouse apps, Zapier. Every key is scoped and every webhook is signed."
        actions={
          <>
            {DEVELOPER_DOCS_URL && (
              <a href={DEVELOPER_DOCS_URL} target="_blank" rel="noreferrer noopener" className={buttonVariants({ variant: 'secondary' })}>
                API docs
              </a>
            )}
            <button type="button" className={buttonVariants()} disabled={locked} onClick={() => setCreating(true)}>
              + Create API key
            </button>
          </>
        }
      />

      {note && <PlanNote kind={note.kind} until={note.kind === 'trial' ? note.until : undefined} canSeePlans={can.viewBilling(activeTenant)} />}

      <div className="flex flex-col gap-6 min-[1440px]:flex-row min-[1440px]:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-6">
          <ApiKeysCard locked={locked} catalogue={scopes.data} onCreate={() => setCreating(true)} />
          <WebhooksCard locked={locked} eventTypes={eventTypes.data} />
        </div>
        <div className="grid w-full gap-6 lg:grid-cols-2 min-[1440px]:flex min-[1440px]:w-[360px] min-[1440px]:shrink-0 min-[1440px]:flex-col">
          <SigningSecretCard locked={locked} />
          <RecentDeliveriesCard locked={locked} onOpenLog={(id) => setLog({ id: id ?? null })} />
          <DocsCard />
        </div>
      </div>

      <CreateKeyModal open={createOpen} canViewCosts={can.viewCosts(activeTenant)} onClose={closeCreate} />
      {log && <DeliveriesDrawer key={log.id ?? 'log'} open initialId={log.id} endpoints={endpoints.data} eventTypes={eventTypes.data} locked={locked} onClose={() => setLog(null)} />}
    </div>
  );
}

/** Plan note 144:41323: brand-50, radius 12, px 16 py 12, 16px lock, Body/14 primary, secondary sm "See plans". */
export function PlanNote({ kind, until, canSeePlans }: { kind: 'locked' | 'trial'; until?: string; canSeePlans: boolean }) {
  return (
    <div role="note" className="flex flex-wrap items-center gap-2.5 rounded-lg bg-brand-50 px-4 py-3">
      <Lock aria-hidden className="size-4 shrink-0 text-brand-600" />
      <p className="min-w-[12rem] flex-1 text-body text-text-primary">
        API keys and webhooks are part of the Growth plan.{kind === 'trial' && ` You’re trying them free until ${until}.`}
      </p>
      {canSeePlans && (
        <Link to="/settings/plan" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
          See plans
        </Link>
      )}
    </div>
  );
}

/** Build with Storeplix 144:41574: 32px brand-50 icon badge (radius 10), Body/14 Medium + Caption secondary. */
function DocsCard() {
  return (
    <DevCard title="Build with Storeplix" gap="gap-3">
      {DEVELOPER_DOCS_URL && (
        <a href={DEVELOPER_DOCS_URL} target="_blank" rel="noreferrer noopener" className="-m-1 rounded-md p-1 outline-none hover:bg-surface-subtle focus-visible:shadow-focus">
          <DocRow icon={<FileText />} title="API reference" subtitle="REST · OpenAPI 3.1 spec" trailing={<ExternalLink aria-hidden className="size-4 text-text-muted" />} />
        </a>
      )}
      <DocRow icon={<ShieldCheck />} title="Rate limits" subtitle={`${DEVELOPER_LIMITS.external_requests_per_minute} requests / minute per key`} />
    </DevCard>
  );
}

function DocRow({ icon, title, subtitle, trailing }: { icon: ReactNode; title: string; subtitle: string; trailing?: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-brand-50 text-brand-600 [&_svg]:size-[18px]">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-body font-medium text-text-primary">{title}</span>
        <span className="text-caption text-text-secondary">{subtitle}</span>
      </span>
      {trailing}
    </div>
  );
}

export default DeveloperPage;
