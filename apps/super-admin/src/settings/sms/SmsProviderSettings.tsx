import type { SmsMessageStatus } from '@storeplix/types';
import { Tabs } from '@storeplix/ui';
import { useSearchParams } from 'react-router';
import { BroadcastsTab } from './BroadcastsTab';
import { parseSmsSettingsTab, SMS_SETTINGS_TAB_LABELS, SMS_SETTINGS_TABS, type SmsSettingsTab } from './format';
import { LogTab } from './LogTab';
import { MessageTypesTab } from './MessageTypesTab';
import { ProviderTab } from './ProviderTab';

// `/settings/sms?tab=provider|messages|broadcasts|log` (PHASE-8-9B §11). Default provider; unknown → provider. The
// tab bar is the merchant detail one (33:5075). `status=failed` (from "View SMS log") pre-filters the log.
export function SmsProviderSettings() {
  const [params, setParams] = useSearchParams();
  const tab = parseSmsSettingsTab(params.get('tab'));
  const status = params.get('status') as SmsMessageStatus | null;
  const go = (next: SmsSettingsTab, extra: Record<string, string> = {}) => setParams({ tab: next, ...extra });

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <Tabs<SmsSettingsTab> aria-label="SMS provider sections" value={tab} onChange={(t) => go(t)} items={SMS_SETTINGS_TABS.map((value) => ({ value, label: SMS_SETTINGS_TAB_LABELS[value] }))} />
      {tab === 'provider' && <ProviderTab onOpenLog={(s) => go('log', s ? { status: s } : {})} />}
      {tab === 'messages' && <MessageTypesTab onOpenBroadcasts={() => go('broadcasts')} />}
      {tab === 'broadcasts' && <BroadcastsTab />}
      {tab === 'log' && (
        <LogTab key={status ?? 'all'} initialStatus={status && ['sent', 'queued', 'failed', 'skipped'].includes(status) ? status : undefined} onSendTest={() => go('provider')} />
      )}
    </div>
  );
}
