import type { SmsTemplateKey } from '@storeplix/types';
import { SMS_TEMPLATE_EVENTS } from '@storeplix/types';
import { Skeleton, Tabs } from '@storeplix/ui';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { ErrorBlock, StateCard } from '../catalog/states';
import { useReadOnly } from '../impersonation/hooks';
import { NoAccessState } from '../layout/RequirePermission';
import { SmsHeader, TestSmsDialog } from './components';
import { CreditsTab } from './CreditsTab';
import { LogTab } from './LogTab';
import { OverviewTab } from './OverviewTab';
import { useSmsOverview } from './queries';
import { SenderIdTab } from './SenderIdTab';
import { canOpenSms, parseSmsTab, smsCapabilities, SMS_TAB_LABELS, visibleTabs, type SmsTab } from './sms';
import { TemplatesTab } from './TemplatesTab';

// PHASE-8-9A §12: Integrations › Messaging › SMS at /integrations/sms?tab=overview|templates|sender-id|log|credits
// (unknown → overview). Visible with settings.manage | integrations.manage | billing.view; tabs and actions follow
// `SmsOverview.can` (P89A-25). `&key=` opens a template in the editor; `&payment=` is the credits purchase return.

const isTemplateKey = (k: string | null): k is SmsTemplateKey => !!k && ([...SMS_TEMPLATE_EVENTS, 'checkout_otp'] as string[]).includes(k);

export function SmsPage() {
  const { activeTenant } = useAuth();
  if (!canOpenSms(activeTenant)) return <NoAccessState heading="SMS" />;
  return <SmsPageInner />;
}

function SmsPageInner() {
  const { activeTenant } = useAuth();
  const readOnly = useReadOnly();
  const [params, setParams] = useSearchParams();
  const overview = useSmsOverview();
  const can = overview.data?.can ?? smsCapabilities(activeTenant);
  const tabs = visibleTabs(can);
  const requested = parseSmsTab(params.get('tab'));
  const tab: SmsTab = tabs.includes(requested) ? requested : 'overview';
  const keyParam = params.get('key');
  const openKey = isTemplateKey(keyParam) ? keyParam : null;
  const paymentId = params.get('payment');
  const [testOpen, setTestOpen] = useState(false);

  const go = (next: SmsTab, extra: Record<string, string> = {}) => {
    const p = new URLSearchParams();
    if (next !== 'overview') p.set('tab', next);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    setParams(p, { replace: false });
  };
  const setOpenKey = (k: SmsTemplateKey | null) => go('templates', k ? { key: k } : {});

  return (
    <div className="flex flex-col gap-5">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-body font-medium">
        <Link to="/integrations" className="text-brand-600 hover:underline">
          Integrations
        </Link>
        <ChevronRight aria-hidden className="size-3.5 text-text-muted" />
        <Link to="/integrations?filter=messaging" className="text-brand-600 hover:underline">
          Messaging
        </Link>
        <ChevronRight aria-hidden className="size-3.5 text-text-muted" />
        <span aria-current="page" className="text-text-secondary">
          SMS
        </span>
      </nav>
      <SmsHeader
        overview={overview.data}
        showBuy={can.view_credit_history || can.buy_credits}
        showTest={can.send_test}
        onBuy={() => go('credits')}
        onTest={() => setTestOpen(true)}
      />
      <Tabs aria-label="SMS sections" value={tab} onChange={(t) => go(t)} items={tabs.map((t) => ({ value: t, label: SMS_TAB_LABELS[t] }))} />

      {tab === 'overview' &&
        (overview.isPending ? (
          <div className="flex flex-col gap-5 lg:flex-row" aria-busy="true" aria-label="Loading SMS overview">
            <Skeleton className="h-96 flex-1 rounded-card" />
            <Skeleton className="h-72 rounded-card lg:w-[340px]" />
          </div>
        ) : overview.isError ? (
          <StateCard>
            <ErrorBlock title="We couldn’t load your SMS overview" error={overview.error} onRetry={() => void overview.refetch()} />
          </StateCard>
        ) : (
          <OverviewTab overview={overview.data} can={can} readOnly={readOnly} onEdit={(k) => setOpenKey(k)} />
        ))}
      {tab === 'templates' && <TemplatesTab overview={overview.data} canEdit={can.edit_templates && !readOnly} openKey={openKey} onOpenKey={setOpenKey} />}
      {tab === 'sender-id' && <SenderIdTab canRequest={can.request_sender_id} readOnly={readOnly} />}
      {tab === 'log' && <LogTab canSendTest={can.send_test} onSendTest={() => setTestOpen(true)} />}
      {tab === 'credits' && (
        <CreditsTab overview={overview.data} canBuy={can.buy_credits} canViewHistory={can.view_credit_history} paymentId={paymentId} onPaymentDone={() => go('credits')} />
      )}

      {testOpen && <TestSmsDialog defaultLanguage={overview.data?.language ?? 'bn'} onClose={() => setTestOpen(false)} />}
    </div>
  );
}

export default SmsPage;
