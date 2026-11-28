import { isApiError } from '@storeplix/api-client';
import type { SmsOverview } from '@storeplix/types';
import { Badge, Button, Chip, cn, Dialog } from '@storeplix/ui';
import { Check, Clock, ShieldCheck } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { timeAgo } from '../commerce/format';
import { formatDate } from '../plan/billing';
import { toast } from '../online-store/components/Toast';
import { smsErrorText } from './errors';
import { useSendTestSms } from './queries';
import { maskPhone } from './sms';

// Figma 31:5120 building blocks shared by every SMS tab: card, key/value row, header and the Send test SMS dialog.

/** Figma card: radius 16, px 24 py 22, border + elevation 1. */
export function Panel({ title, description, actions, children, className, label }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string; label?: string }) {
  return (
    <section aria-label={label ?? (typeof title === 'string' ? title : undefined)} className={cn('flex flex-col gap-3 rounded-card border border-border-default bg-surface-card px-4 py-[18px] shadow-elevation-1 sm:px-6 sm:py-[22px]', className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            {title && <h2 className="text-body-lg font-medium text-text-primary">{title}</h2>}
            {description && <p className="text-caption text-text-secondary">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function KeyValue({ label, value, valueClassName }: { label: ReactNode; value: ReactNode; valueClassName?: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="min-w-0 flex-1 text-body text-text-secondary">{label}</span>
      <span className={cn('shrink-0 text-body font-medium text-text-primary', valueClassName)}>{value}</span>
    </div>
  );
}

/** "Sender: Storeplix · MUGDHO in review" (§12). */
export function senderLine(o: Pick<SmsOverview, 'sender'>): string {
  const base = `Sender: ${o.sender.type === 'masked' && o.sender.sender_id ? o.sender.sender_id : 'Storeplix'}`;
  return o.sender.pending_request ? `${base} · ${o.sender.pending_request.sender_id} in review` : base;
}

/** Header card 31:5131: SMS tile, Active pill, Messaging tag, description, meta line and actions. */
export function SmsHeader({ overview, onBuy, onTest, showBuy, showTest }: { overview: SmsOverview | undefined; onBuy: () => void; onTest: () => void; showBuy: boolean; showTest: boolean }) {
  return (
    <section aria-label="SMS" className="flex flex-col gap-4 rounded-card border border-border-default bg-surface-card px-4 py-[18px] shadow-elevation-1 sm:flex-row sm:items-center sm:gap-5 sm:px-6 sm:py-[22px]">
      <div className="flex items-start gap-4 sm:contents">
        <span aria-hidden className="flex size-12 shrink-0 items-center justify-center rounded-card bg-brand-600 text-body font-semibold text-text-inverse sm:size-16">
          SMS
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-heading-24 font-semibold text-text-primary">SMS</h1>
            <Badge tone="success" dot size="sm">
              Active
            </Badge>
            <Badge size="sm">Messaging</Badge>
          </div>
          <p className="text-body text-text-secondary">
            Send order updates, OTP codes and receipts in Bangla or English. Messages go through the Storeplix SMS gateway (BTRC-approved) — nothing to connect.
          </p>
          {overview && (
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-text-secondary">
              {overview.gateway.active_since && (
                <li className="flex items-center gap-1.5">
                  <Check aria-hidden className="size-3.5 text-text-muted" />
                  Active since {formatDate(overview.gateway.active_since)}
                </li>
              )}
              {overview.gateway.last_sent_at && (
                <li className="flex items-center gap-1.5">
                  <Clock aria-hidden className="size-3.5 text-text-muted" />
                  Last SMS {timeAgo(overview.gateway.last_sent_at)}
                </li>
              )}
              <li className="flex items-center gap-1.5">
                <ShieldCheck aria-hidden className="size-3.5 text-text-muted" />
                {senderLine(overview)}
              </li>
            </ul>
          )}
        </div>
      </div>
      {(showBuy || showTest) && (
        <div className="flex flex-col gap-2 sm:shrink-0 sm:flex-row">
          {showBuy && (
            <Button variant="secondary" onClick={onBuy}>
              Buy credits
            </Button>
          )}
          {showTest && <Button onClick={onTest}>Send test SMS</Button>}
        </div>
      )}
    </section>
  );
}

/** §12.1 Send test SMS dialog: to the signed-in member's verified phone only (no `to` field). */
export function TestSmsDialog({ defaultLanguage, onClose }: { defaultLanguage: 'bn' | 'en'; onClose: () => void }) {
  const { user } = useAuth();
  const [language, setLanguage] = useState<'bn' | 'en'>(defaultLanguage);
  const send = useSendTestSms();
  const verified = !!user?.phone && !!user.phone_verified_at;
  const masked = maskPhone(user?.phone);
  const code = isApiError(send.error) ? send.error.code : null;
  const notVerified = !verified || code === 'phone_not_verified';

  return (
    <Dialog
      open
      size="sm"
      title="Send test SMS"
      description={verified ? `We’ll text ${masked}. It counts like any order SMS.` : undefined}
      confirmLabel="Send"
      confirmDisabled={notVerified}
      loading={send.isPending}
      onCancel={() => !send.isPending && onClose()}
      onConfirm={() =>
        send.mutate(
          { language },
          {
            onSuccess: (r) => {
              toast(`Test SMS sent to ${r.to_masked}`);
              onClose();
            },
          },
        )
      }
    >
      <div className="flex flex-col gap-3">
        <div role="group" aria-label="Test SMS language" className="flex gap-2">
          {(
            [
              ['bn', 'বাংলা'],
              ['en', 'English'],
            ] as const
          ).map(([value, label]) => (
            <Chip key={value} selected={language === value} check={false} className={value === 'bn' ? 'font-bangla' : undefined} onClick={() => setLanguage(value)}>
              {label}
            </Chip>
          ))}
        </div>
        {notVerified ? (
          <p role="alert" className="rounded-lg bg-warning-bg px-4 py-3 text-body text-text-primary">
            Verify your phone in your profile first.{' '}
            <Link to="/account" className="font-medium text-brand-600 hover:underline">
              Open your profile
            </Link>
          </p>
        ) : code === 'sms_credits_exhausted' ? (
          <p role="alert" className="rounded-lg bg-danger-bg px-4 py-3 text-body text-text-primary">
            No SMS left —{' '}
            <Link to="/integrations/sms?tab=credits" onClick={onClose} className="font-medium text-brand-600 hover:underline">
              buy credits
            </Link>
          </p>
        ) : send.error ? (
          <p role="alert" className="rounded-lg bg-danger-bg px-4 py-3 text-body text-text-primary">
            {smsErrorText(send.error)}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
