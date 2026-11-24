import type { CampaignChannel, CampaignEstimate, CampaignLanguage } from '@storeplix/types';
import { buttonVariants, cn, formatCount } from '@storeplix/ui';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { mergeBody, SAMPLE_NAME, smsFooter, smsPrefix, type SampleContext } from './campaigns';

// Figma 70:20183 right column: "PREVIEW ON PHONE" phone frame (radius 40, p 12, dark bezel = text-primary; screen
// surface-subtle radius 30, 520 tall) with the SMS bubble (header = store initial + name, "Text message · <time>",
// footer "n parts" instead of "Delivered") or, for email, an email card inside the same frame (§8.3). The Cost
// estimate card becomes **Allowance** (no Top up, no ৳ rate/total, no Expected orders row).

export function PhonePreview({
  channel,
  language,
  body,
  subject,
  ctx,
  parts,
  logoUrl,
  contactLine,
}: {
  channel: CampaignChannel;
  language: CampaignLanguage;
  body: string;
  subject: string;
  ctx: SampleContext;
  parts: number;
  logoUrl?: string | null;
  contactLine?: string | null;
}) {
  const sample = { ...ctx, name: SAMPLE_NAME[language] };
  const merged = mergeBody(body, sample);
  const now = new Date();
  const clock = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(now);
  const shop = ctx.shopName || 'Your shop';
  return (
    <div className="flex flex-col gap-4">
      <p className="text-caption font-medium text-text-muted uppercase">Preview on phone</p>
      <div className="mx-auto w-full max-w-[360px] rounded-[40px] bg-text-primary p-3 shadow-elevation-1">
        <div className="flex h-[520px] flex-col overflow-hidden rounded-[30px] bg-surface-subtle">
          <div aria-hidden className="flex px-5 pt-3.5 pb-1.5 text-caption font-medium text-text-primary">
            <span>{clock.replace(/\s?[AP]M$/, '')}</span>
            <span className="flex-1" />
            <span className="whitespace-pre">5G ▮▮▮</span>
          </div>
          {channel === 'sms' ? (
            <>
              <div className="flex flex-col items-center gap-1 border-b border-border-default bg-surface-card px-4 pt-2 pb-3">
                <span aria-hidden className="flex size-10 items-center justify-center rounded-full bg-brand-600 text-body-lg font-medium text-text-inverse">
                  {shop.trim().charAt(0).toUpperCase()}
                </span>
                <span className="text-body font-semibold text-text-primary">{shop}</span>
                <span className="text-caption text-text-muted">Text message · Today {clock}</span>
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
                <div
                  data-testid="sms-bubble"
                  className={cn('w-[260px] max-w-full rounded-[18px] rounded-tl-[4px] bg-surface-card px-3.5 py-2.5 whitespace-pre-line break-words text-text-primary', language === 'bn' ? 'font-bangla text-[16px] leading-[26px]' : 'text-body')}
                >
                  {body.trim() ? `${smsPrefix(ctx.shopName)}${merged}\n${smsFooter(language, ctx.host)}` : <span className="text-text-muted">Your message shows here.</span>}
                </div>
                <p className="text-caption text-text-muted">{parts === 1 ? '1 part' : `${parts} parts`}</p>
              </div>
            </>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
              <div className="flex flex-col gap-3 rounded-2xl bg-surface-card p-4" data-testid="email-preview">
                <p className="text-body font-semibold break-words text-text-primary">{subject.trim() || 'Subject'}</p>
                <div className="flex items-center gap-2 border-b border-border-default pb-3">
                  {logoUrl ? (
                    <img src={logoUrl} alt="" className="size-8 shrink-0 rounded-md object-contain" />
                  ) : (
                    <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-md bg-brand-600 text-body font-medium text-text-inverse">
                      {shop.trim().charAt(0).toUpperCase()}
                    </span>
                  )}
                  <span className="truncate text-body font-medium text-text-primary">{shop}</span>
                </div>
                <div className={cn('flex flex-col gap-2 break-words text-text-primary', language === 'bn' ? 'font-bangla text-[15px] leading-6' : 'text-body')}>
                  {merged.trim() ? merged.split(/\n\s*\n/).map((para, i) => <p key={i} className="whitespace-pre-line">{para}</p>) : <p className="text-text-muted">Your message shows here.</p>}
                </div>
                <div className="flex flex-col gap-1 border-t border-border-default pt-3 text-caption text-text-muted">
                  {contactLine && <span>{contactLine}</span>}
                  <span>
                    Don’t want these emails? <span className="text-brand-600 underline">Unsubscribe</span>
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, strong }: { label: ReactNode; value: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-start gap-3">
      <span className={cn('flex-1', strong ? 'text-body-lg font-medium text-text-primary' : 'text-body text-text-secondary')}>{label}</span>
      <span className={cn('shrink-0 text-text-primary', strong ? 'text-body-lg font-medium' : 'text-body font-medium')}>{value}</span>
    </div>
  );
}

/** Allowance card (was Cost estimate 70:20330). */
export function AllowanceCard({
  channel,
  recipients,
  perPerson,
  allowance,
  estimate,
  canSeePlans,
}: {
  channel: CampaignChannel;
  recipients: number | null;
  perPerson: number;
  /** From `/features` (this month). */
  allowance: { limit: number | null; used: number } | undefined;
  /** Server estimate when available (authoritative). */
  estimate: CampaignEstimate | undefined;
  canSeePlans: boolean;
}) {
  const sms = channel === 'sms';
  const recip = estimate?.recipients ?? recipients;
  const per = estimate?.parts_per_recipient ?? perPerson;
  const total = estimate?.total_parts ?? (recip === null ? null : recip * per);
  const limit = estimate ? estimate.allowance.limit : (allowance?.limit ?? null);
  const used = estimate ? estimate.allowance.used : (allowance?.used ?? 0);
  const remaining = limit === null ? null : Math.max(0, limit - used);
  const after = estimate ? estimate.allowance.after : remaining === null || total === null ? null : remaining - total;
  const over = after !== null && after < 0;
  const noun = sms ? 'Campaign SMS' : 'Campaign emails';
  return (
    <section aria-label="Allowance" className="flex flex-col gap-2.5 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1">
      <h2 className="text-body-lg font-medium text-text-primary">Allowance</h2>
      <Row label="Recipients" value={recip === null ? '—' : formatCount(recip)} />
      <Row label={sms ? 'SMS per person' : 'Emails per person'} value={formatCount(per)} />
      <div className="h-px bg-border-default" />
      <Row label={sms ? 'Total SMS' : 'Total emails'} value={total === null ? '—' : formatCount(total)} strong />
      {limit === null && allowance ? (
        <p className="rounded-md bg-surface-subtle px-3 py-2.5 text-caption font-medium text-text-secondary">{noun}: no monthly limit on your plan</p>
      ) : remaining !== null ? (
        <p data-testid="allowance-row" className={cn('rounded-md px-3 py-2.5 text-caption font-medium', over ? 'bg-danger-bg text-danger' : 'bg-surface-subtle text-text-secondary')}>
          {noun} left this month {formatCount(remaining)} → {after === null ? '—' : formatCount(Math.max(0, after))} after
        </p>
      ) : null}
      {over && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md bg-danger-bg px-3 py-2.5 text-caption font-medium text-danger">
          <span className="min-w-0 flex-1">Not enough left this month: you need {formatCount(total ?? 0)} and have {formatCount(remaining ?? 0)}.</span>
          {canSeePlans && (
            <Link to="/settings/plan" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
              See plans
            </Link>
          )}
        </div>
      )}
    </section>
  );
}
