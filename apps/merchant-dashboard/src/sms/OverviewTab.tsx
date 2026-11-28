import type { SmsCapabilities, SmsLowCreditThreshold, SmsOverview, SmsTemplate, SmsTemplateEvent } from '@storeplix/types';
import { SMS_TEMPLATE_EVENTS } from '@storeplix/types';
import { Badge, Button, cn, formatCount, SegmentedControl, Select, Skeleton, Toggle } from '@storeplix/ui';
import { Lock } from 'lucide-react';
import { Link } from 'react-router';
import { ErrorBlock } from '../catalog/states';
import { planName, useFeatures } from '../plan/useFeatures';
import { useSaveSettings } from '../settings/commerceSettings';
import { toast } from '../online-store/components/Toast';
import { KeyValue, Panel } from './components';
import { MiniPackPicker, providerName, PurchaseError, usePurchaseFlow } from './CreditsTab';
import { smsErrorText } from './errors';
import { useSmsCredits, useSmsInvalidate, useSmsTemplates, useUpdateCreditAlert } from './queries';
import { allowanceLine, allowanceUsedFraction, creditStatusMeta, formatRate, LOW_CREDIT_OPTIONS, nextResetLabel, quietHoursLabel } from './sms';

// Figma Overview 31:5120 (mobile 2081:1197), §12.1. The language and the per-event switches are the store settings
// (`notifications.sms_language`, `notifications.customer_sms`), the same data as Settings → Notifications (P89A-10).
// "Delivered" row hidden (Q272); quiet hours and sender name are read-only (Q268).

export function OverviewTab({ overview, can, onEdit, readOnly }: { overview: SmsOverview; can: SmsCapabilities; onEdit: (key: SmsTemplateEvent) => void; readOnly: boolean }) {
  return (
    <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
      <div className="order-2 flex min-w-0 flex-1 flex-col gap-5 lg:order-1">
        <AutomaticMessages overview={overview} canEdit={can.edit_templates && !readOnly} onEdit={onEdit} />
        <SendingRules overview={overview} canEditAlert={can.edit_low_credit_alert && !readOnly} />
      </div>
      <div className="order-1 flex flex-col gap-5 lg:order-2 lg:w-[340px] lg:shrink-0">
        <CreditsCard overview={overview} canBuy={can.buy_credits && !readOnly} />
        <ThisMonth overview={overview} />
      </div>
    </div>
  );
}

function AutomaticMessages({ overview, canEdit, onEdit }: { overview: SmsOverview; canEdit: boolean; onEdit: (key: SmsTemplateEvent) => void }) {
  const templates = useSmsTemplates();
  const save = useSaveSettings('SMS settings saved.');
  const invalidate = useSmsInvalidate();
  const lang = overview.language;
  const byKey = new Map((templates.data ?? []).filter((t) => t.language === lang).map((t) => [t.key, t] as const));
  const otp = byKey.get('checkout_otp');
  const patch = (input: Parameters<typeof save.mutate>[0]) => save.mutate(input, { onSuccess: () => void invalidate() });

  return (
    <Panel
      title="Automatic messages"
      description="Sent when the order changes. Bangla uses about 2× the credits of English."
      actions={
        <SegmentedControl
          size="sm"
          aria-label="SMS language"
          value={lang}
          disabled={!canEdit || save.isPending}
          onChange={(v) => v !== lang && patch({ notifications: { sms_language: v } })}
          options={[
            { value: 'bn', label: <span className="font-bangla">বাংলা</span> },
            { value: 'en', label: 'English' },
          ]}
        />
      }
    >
      {templates.isPending ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 rounded-lg" />
          ))}
        </div>
      ) : templates.isError ? (
        <ErrorBlock title="We couldn’t load your messages" error={templates.error} onRetry={() => void templates.refetch()} />
      ) : (
        <ul aria-label="Automatic messages" className="flex flex-col">
          {SMS_TEMPLATE_EVENTS.map((key) => {
            const t = byKey.get(key);
            if (!t) return null;
            return (
              <MessageRow key={key} t={t}>
                <button type="button" onClick={() => onEdit(key)} className="rounded-sm text-body font-medium text-brand-600 outline-none hover:underline focus-visible:shadow-focus">
                  {canEdit ? 'Edit' : 'View'}
                  <span className="sr-only"> {t.label}</span>
                </button>
                {t.enabled !== null && (
                  <Toggle
                    label={`SMS: ${t.label}`}
                    checked={t.enabled}
                    disabled={!canEdit || save.isPending}
                    onChange={(v) => patch({ notifications: { customer_sms: { [key]: v } } })}
                  />
                )}
              </MessageRow>
            );
          })}
          {otp && (
            <MessageRow t={otp} readOnlyTag>
              <Link to="/orders/fraud-guard" className="flex items-center gap-1.5 text-body font-medium text-brand-600 hover:underline">
                <Lock aria-hidden className="size-3.5" />
                Managed by Fake order guard
              </Link>
            </MessageRow>
          )}
        </ul>
      )}
    </Panel>
  );
}

function MessageRow({ t, readOnlyTag, children }: { t: SmsTemplate; readOnlyTag?: boolean; children: React.ReactNode }) {
  return (
    <li className="flex flex-col gap-2 border-b border-border-default py-3 last:border-b-0 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body font-semibold text-text-primary">{t.label}</span>
          <Badge size="sm">{t.preview.parts} SMS</Badge>
          {readOnlyTag && (
            <Badge size="sm">
              <Lock aria-hidden className="size-3" />
              Read-only
            </Badge>
          )}
        </div>
        <p className={cn('rounded-control bg-surface-canvas px-3 py-2 text-[13px] leading-5 text-text-secondary', t.language === 'bn' && 'font-bangla')}>{t.preview.text}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3 self-end sm:self-center">{children}</div>
    </li>
  );
}

function SendingRules({ overview, canEditAlert }: { overview: SmsOverview; canEditAlert: boolean }) {
  const alert = useUpdateCreditAlert();
  const threshold = overview.credits.low_credit_threshold;
  const masked = overview.sender.type === 'masked' && overview.sender.sender_id;
  const pending = overview.sender.pending_request;
  const senderCaption = masked
    ? `All SMS come from ${overview.sender.sender_id} without the shop-name prefix.`
    : pending
      ? `Shows as the sender on the customer’s phone. Your masked ID ${pending.sender_id} is in review.`
      : 'Shows as the sender on the customer’s phone.';
  return (
    <Panel title="Sending rules">
      <Rule title="Quiet hours" caption="Campaigns and automations wait; order updates and codes always send.">
        <span className="text-body font-medium text-text-primary">{quietHoursLabel(overview.quiet_hours)}</span>
      </Rule>
      <Rule
        title="Sender name"
        caption={
          <>
            {senderCaption}{' '}
            <Link to="/integrations/sms?tab=sender-id" className="font-medium text-brand-600 hover:underline">
              Sender ID
            </Link>
          </>
        }
      >
        <span className="text-body font-medium text-text-primary">{masked ? overview.sender.sender_id : 'Storeplix (default)'}</span>
      </Rule>
      <Rule title="Low-credit alert" caption="Notify you before messages stop." last>
        <Select
          aria-label="Low-credit alert"
          containerClassName="w-44"
          value={threshold === null ? '' : String(threshold)}
          disabled={!canEditAlert || alert.isPending}
          onChange={(e) => {
            const v = e.target.value;
            alert.mutate(
              { low_credit_threshold: v ? (Number(v) as SmsLowCreditThreshold) : null },
              { onSuccess: () => toast('Low-credit alert saved.'), onError: (err) => toast(smsErrorText(err), 'error') },
            );
          }}
        >
          {LOW_CREDIT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Rule>
    </Panel>
  );
}

function Rule({ title, caption, children, last }: { title: string; caption: React.ReactNode; children: React.ReactNode; last?: boolean }) {
  return (
    <div className={cn('flex flex-col gap-2 py-[13px] sm:flex-row sm:items-center sm:gap-4', !last && 'border-b border-border-default')}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-body font-semibold text-text-primary">{title}</span>
        <span className="text-caption text-text-secondary">{caption}</span>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function CreditsCard({ overview, canBuy }: { overview: SmsOverview; canBuy: boolean }) {
  const c = overview.credits;
  const status = creditStatusMeta(c.status);
  const tx = overview.allowance.transactional;
  const mk = overview.allowance.marketing;
  const features = useFeatures();
  const account = useSmsCredits();
  const flow = usePurchaseFlow(canBuy ? account.data : undefined);
  return (
    <Panel title="SMS credits" actions={status && <Badge tone={status.tone}>{status.label}</Badge>}>
      <p className="flex flex-wrap items-baseline gap-1.5">
        <span className="text-display font-bold text-text-primary">{tx.limit === null ? 'Unlimited' : formatCount((tx.remaining ?? 0) + c.balance)}</span>
        <span className="text-body text-text-secondary">SMS left{c.estimated_days_left !== null ? ` · ~${c.estimated_days_left} days` : ''}</span>
      </p>
      <div className="flex flex-col gap-1.5">
        <KeyValue label="Plan allowance" value={allowanceLine(tx)} />
        {tx.limit !== null && (
          <div className="h-2 overflow-hidden rounded-full bg-surface-subtle" role="progressbar" aria-label="Plan allowance used" aria-valuenow={tx.used} aria-valuemin={0} aria-valuemax={tx.limit}>
            <div className="h-full rounded-full bg-brand-600" style={{ width: `${allowanceUsedFraction(tx) * 100}%` }} />
          </div>
        )}
        <p className="text-caption text-text-muted">
          {features.data ? `${planName(features.data.plan_code)} plan · ` : ''}resets {nextResetLabel()} · used first
        </p>
        <p className="text-caption text-text-secondary">Campaign SMS {mk.limit === null ? 'unlimited' : `${formatCount(mk.remaining ?? 0)} of ${formatCount(mk.limit)}`}</p>
      </div>
      <div className="h-px bg-border-default" />
      <div className="flex flex-col gap-0.5">
        <KeyValue label="Purchased credits" value={formatCount(c.balance)} />
        <p className="text-caption text-text-muted">Used after the allowance · never expire</p>
      </div>
      {canBuy && account.data && flow.packs.length > 0 && (
        <>
          <p className="text-caption font-medium text-text-secondary">Top up purchased credits</p>
          <MiniPackPicker packs={flow.packs} value={flow.pack?.code} onChange={flow.setPack} />
          {flow.providers.length === 0 ? (
            <p className="text-caption text-text-secondary">Online payment isn’t available right now.</p>
          ) : (
            <Button fullWidth loading={flow.pending} disabled={!flow.pack || !flow.provider || flow.pending} onClick={flow.buy}>
              {flow.pack && flow.provider ? `Buy ${formatCount(flow.pack.credits)} credits with ${providerName[flow.provider]}` : 'Buy credits'}
            </Button>
          )}
          <PurchaseError message={flow.error} />
        </>
      )}
    </Panel>
  );
}

function ThisMonth({ overview }: { overview: SmsOverview }) {
  const m = overview.this_month;
  return (
    <Panel title="This month">
      <KeyValue label="Messages sent" value={formatCount(m.messages_sent)} />
      <KeyValue label="Sent successfully" value={formatRate(m.sent_success_rate)} valueClassName={m.sent_success_rate !== null ? 'text-success' : undefined} />
      <KeyValue label="Credits used" value={formatCount(m.credits_used)} />
      <KeyValue label="OTP sent" value={formatCount(m.otp_sent)} />
    </Panel>
  );
}
