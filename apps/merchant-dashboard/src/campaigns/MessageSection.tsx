import type { CampaignChannel, CampaignLanguage } from '@storeplix/types';
import { Badge, Chip, cn, formatCount, Input, Menu } from '@storeplix/ui';
import { X } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { insertAt, MAX_EMAIL_BODY, MAX_SMS_PARTS, MAX_SUBJECT, MERGE_FIELDS, partSegments, smsHint, type MergeField, type SmsSample } from './campaigns';
import { CouponPicker, ProductPicker } from './Pickers';
import { CAMPAIGN_TEMPLATES, type CampaignTemplate } from './templates';
import { StepCard } from './ui';

// Figma 70:20246 Message: language chips বাংলা / English + "Template: …" link (4 templates, Q150), message box
// (brand-500 border, radius 12, p 16; Bangla/16 Hind Siliguri for bn) with the merge-tag row ("+ Customer name",
// "+ Coupon code" → coupon picker, "+ Shop link", "+ Product" → product picker). SMS: the auto prefix and opt-out footer
// are shown greyed in the box (P85-6/18); counter "Unicode (Bangla) · n characters", "n SMS per person" pill (warning
// when > 1), part bar and hint (money text removed). Email: Subject above the box, plain-text counter.

export function MessageSection({
  channel,
  language,
  body,
  subject,
  coupon,
  product,
  sms,
  errors,
  disabled,
  onLanguage,
  onBody,
  onSubject,
  onCoupon,
  onProduct,
}: {
  channel: CampaignChannel;
  language: CampaignLanguage;
  body: string;
  subject: string;
  coupon: { id: string; code: string } | null;
  product: { id: string; name: string; slug: string } | null;
  sms: SmsSample;
  errors: Record<string, string>;
  disabled?: boolean;
  onLanguage: (l: CampaignLanguage) => void;
  onBody: (b: string) => void;
  onSubject: (s: string) => void;
  onCoupon: (c: { id: string; code: string } | null) => void;
  onProduct: (p: { id: string; name: string; slug: string } | null) => void;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const bodyId = useId();
  const [template, setTemplate] = useState<CampaignTemplate | null>(null);
  const [picker, setPicker] = useState<'coupon' | 'product' | null>(null);
  const bn = language === 'bn';

  const insert = (field: MergeField) => {
    const el = area.current;
    const { text, caret } = insertAt(body, `{${field}}`, el?.selectionStart, el?.selectionEnd);
    onBody(text);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  };

  const onTag = (field: MergeField) => {
    if (field === 'coupon') setPicker('coupon');
    else if (field === 'product') setPicker('product');
    else insert(field);
  };

  const applyTemplate = (t: CampaignTemplate) => {
    setTemplate(t);
    onBody(t.text[language].body);
    if (channel === 'email') onSubject(t.text[language].subject);
  };

  const c = sms.count;
  return (
    <StepCard step={3} title="Message">
      <div className="flex flex-wrap items-center gap-2">
        <Chip check={false} selected={bn} disabled={disabled} onClick={() => onLanguage('bn')} lang="bn" className="font-bangla">
          বাংলা
        </Chip>
        <Chip check={false} selected={!bn} disabled={disabled} onClick={() => onLanguage('en')}>
          English
        </Chip>
        <span className="flex-1" />
        <Menu
          label={`Template: ${template?.label ?? "choose"}`}
          align="end"
          disabled={disabled}
          triggerClassName="h-auto w-auto px-1 text-caption font-medium text-brand-600 hover:bg-transparent"
          trigger={<span>Template: {template?.label ?? 'choose'}</span>}
          entries={CAMPAIGN_TEMPLATES.map((t) => ({ key: t.key, label: t.label, onSelect: () => applyTemplate(t) }))}
          className="w-[240px]"
        />
      </div>

      {channel === 'email' && <Input label="Subject" value={subject} maxLength={MAX_SUBJECT} disabled={disabled} error={errors.subject} onChange={(e) => onSubject(e.target.value.replace(/[\r\n]/g, ' '))} className={cn(bn && 'font-bangla')} />}

      <div className={cn('flex flex-col gap-3 rounded-lg border p-4 focus-within:shadow-focus', errors.body ? 'border-danger' : 'border-brand-500')}>
        {channel === 'sms' && (
          <p className="text-caption text-text-muted" title="Added automatically">
            {sms.prefix}
          </p>
        )}
        <label htmlFor={bodyId} className="sr-only">
          Message text
        </label>
        <textarea
          id={bodyId}
          ref={area}
          value={body}
          disabled={disabled}
          rows={channel === 'email' ? 8 : 4}
          maxLength={channel === 'email' ? MAX_EMAIL_BODY : 1000}
          aria-invalid={!!errors.body}
          aria-describedby={`${bodyId}-count`}
          placeholder={bn ? 'প্রিয় {name}, …' : 'Hi {name}, …'}
          onChange={(e) => onBody(e.target.value)}
          className={cn('w-full resize-y bg-transparent text-text-primary outline-none placeholder:text-text-muted', bn ? 'font-bangla text-[16px] leading-[26px]' : 'text-body')}
        />
        {channel === 'sms' && <p className={cn('text-caption text-text-muted', bn && 'font-bangla')}>{sms.footer}</p>}
        <div className="flex flex-wrap gap-2">
          {MERGE_FIELDS.map((t) => (
            <button
              key={t.field}
              type="button"
              disabled={disabled}
              onClick={() => onTag(t.field)}
              className="rounded-full bg-surface-subtle px-2 py-0.5 text-caption font-medium text-text-secondary outline-none hover:bg-border-default focus-visible:shadow-focus disabled:opacity-50"
            >
              {t.label}
            </button>
          ))}
        </div>
        {(coupon || product) && (
          <div className="flex flex-wrap gap-2 text-caption text-text-secondary">
            {coupon && (
              <PickedTag label={`Coupon ${coupon.code}`} onRemove={disabled ? undefined : () => onCoupon(null)} />
            )}
            {product && <PickedTag label={`Product ${product.name}`} onRemove={disabled ? undefined : () => onProduct(null)} />}
          </div>
        )}
      </div>
      {errors.body && (
        <p role="alert" className="-mt-2 text-caption text-danger">
          {errors.body}
        </p>
      )}

      {channel === 'sms' ? (
        <div id={`${bodyId}-count`} className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <p className="flex-1 text-caption font-medium text-text-secondary">
              {c.encoding === 'ucs2' ? 'Unicode (Bangla)' : 'GSM (English)'} · {formatCount(c.units)} characters
            </p>
            <Badge tone={c.parts > MAX_SMS_PARTS ? 'danger' : c.parts > 1 ? 'warning' : 'neutral'} dot data-testid="sms-parts">
              {c.parts === 1 ? '1 SMS per person' : `${c.parts} SMS per person`}
            </Badge>
          </div>
          <div aria-hidden className="flex h-1.5 gap-1">
            {partSegments(c).map((s, i) => (
              <span key={i} className={cn('h-1.5 min-w-px rounded-full', s.filled ? (i % 2 === 0 ? 'bg-brand-600' : 'bg-brand-500') : 'bg-surface-subtle')} style={{ flex: `${s.size} 0 0` }} />
            ))}
          </div>
          <p className="text-caption text-text-muted">{smsHint(c)} The shop name and the opt-out link are included.</p>
        </div>
      ) : (
        <p id={`${bodyId}-count`} className="text-caption text-text-muted">
          {formatCount(body.length)} / {formatCount(MAX_EMAIL_BODY)} characters · plain text; links start with https:// · an unsubscribe link is added at the bottom.
        </p>
      )}

      <CouponPicker
        open={picker === 'coupon'}
        onClose={() => setPicker(null)}
        onPick={(cp) => {
          onCoupon(cp);
          setPicker(null);
          if (!body.includes('{coupon}')) insert('coupon');
        }}
      />
      <ProductPicker
        open={picker === 'product'}
        onClose={() => setPicker(null)}
        onPick={(p) => {
          onProduct(p);
          setPicker(null);
          if (!body.includes('{product}')) insert('product');
        }}
      />
    </StepCard>
  );
}

function PickedTag({ label, onRemove }: { label: string; onRemove?: () => void }) {
  return (
    <Badge size="sm" tone="brand" className="pr-1">
      {label}
      {onRemove && (
        <button type="button" aria-label={`Remove ${label}`} onClick={onRemove} className="rounded-full p-0.5 hover:bg-brand-100">
          <X aria-hidden className="size-3" />
        </button>
      )}
    </Badge>
  );
}
