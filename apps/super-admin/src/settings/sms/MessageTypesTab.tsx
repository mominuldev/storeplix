import { isApiError } from '@storeplix/api-client';
import {
  SMS_TEMPLATE_MAX_PARTS,
  type PlatformSmsGroup,
  type PlatformSmsGroupInfo,
  type PlatformSmsMessageType,
  type PlatformSmsTemplate,
} from '@storeplix/types';
import { Badge, Button, Chip, cn, Dialog, Drawer, formatBdt, formatCount, KpiTile, Toggle } from '@storeplix/ui';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Lock } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ErrorState, LoadingRows } from '../../components/States';
import { api } from '../../lib/api';
import { useDebounced } from '../../lib/useDebounced';
import { useToast } from '../../lib/toast';
import { countTemplate, insertAt, normalizeBody, templateProblem, templateProblemText, type TemplateCount } from './format';
import { platformSmsKeys, smsErrorText } from './queries';
import { SectionCard, TestSmsDialog } from './ui';

// Message types tab (PHASE-8-9B §11.4, Figma 2098:8963): KPI strip; four group cards with a meta bar (sender,
// provider, rate limit) and rows (label, trigger, "{parts} SMS" tag, বাংলা + EN previews, Edit, switch; locked rows:
// lock, "Always on", View). Promotional card adds the rules box and the Broadcasts row (→ Broadcasts tab). Figma rows
// "New sign-in alert", "Trial ending offer", "Win-back" and "2-step code" are not shown (Q278). Editor: drawer
// 2098:9466 / 2101:9413, the 8.9a editor pattern.

const GROUP_ORDER: PlatformSmsGroup[] = ['registration', 'billing', 'security', 'promotional'];
const GROUP_COPY: Record<PlatformSmsGroup, { title: string; description: string }> = {
  registration: { title: 'Registration', description: 'Sent when a merchant signs up or verifies a phone number.' },
  billing: { title: 'Invoice & billing', description: 'Subscription invoices and payment reminders, next to the billing emails.' },
  security: { title: 'Login & security', description: 'Sign-in codes are always on and their text can’t be edited.' },
  promotional: { title: 'Promotional', description: 'Platform offers and news to merchants. BTRC promotional rules apply.' },
};
const PREVIEW_DEBOUNCE_MS = 400;

export function MessageTypesTab({ onOpenBroadcasts }: { onOpenBroadcasts: () => void }) {
  const query = useQuery({ queryKey: platformSmsKeys.messageTypes, queryFn: () => api.admin.platformSms.messageTypes.list() });
  const [open, setOpen] = useState<{ type: PlatformSmsMessageType; language: 'bn' | 'en' } | null>(null);

  if (query.isPending) return <LoadingRows label="Loading message types" rows={8} />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const { data, meta } = query.data;
  const k = meta.kpis;
  const current = open ? data.find((t) => t.type === open.type.type) ?? open.type : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label="Sent this month" value={formatCount(k.sent_this_month)} hint="SMS parts · all platform types" />
        <KpiTile label="Sign-in codes" value={formatCount(k.codes_this_month)} hint={k.sent_this_month ? `${Math.round((k.codes_this_month / k.sent_this_month) * 100)}% of volume` : '—'} />
        <KpiTile label="Promotional" value={formatCount(k.promotional_this_month)} hint="Broadcast SMS this month" />
        <KpiTile label="Cost this month" value={formatBdt(k.cost_this_month_paisa)} hint="Estimate at the provider price" />
      </div>
      {GROUP_ORDER.map((g) => {
        const rows = data.filter((t) => t.group === g);
        if (!rows.length) return null;
        const info = meta.groups.find((x) => x.group === g);
        return (
          <SectionCard
            key={g}
            title={GROUP_COPY[g].title}
            description={GROUP_COPY[g].description}
            actions={
              g === 'security' ? (
                <Badge size="sm" tone="info">
                  Always on
                </Badge>
              ) : g === 'promotional' ? (
                <Button size="sm" variant="ghost" onClick={onOpenBroadcasts}>
                  Open Broadcasts
                </Button>
              ) : undefined
            }
          >
            <MetaBar info={info} />
            {g === 'promotional' && <PromoRules />}
            <ul className="flex flex-col divide-y divide-border-default">
              {rows.map((t) => (
                <TypeRow key={t.type} type={t} onOpen={(language) => (t.type === 'broadcast' ? onOpenBroadcasts() : setOpen({ type: t, language }))} />
              ))}
            </ul>
          </SectionCard>
        );
      })}
      {current && open && <TemplateEditor type={current} defaultLanguage={open.language} onClose={() => setOpen(null)} />}
    </div>
  );
}

function MetaBar({ info }: { info: PlatformSmsGroupInfo | undefined }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-md bg-surface-subtle px-3 py-2 text-caption text-text-muted">
      <span>
        Sender <span className="font-medium text-text-primary">{info?.sender_id ?? '—'}</span>
      </span>
      <span>
        Provider{' '}
        <span className={cn('font-medium', info?.provider ? 'text-text-primary' : 'text-danger')}>
          {info?.provider ? (info.provider.id === null ? `${info.provider.name} (environment)` : info.provider.name) : 'None can send'}
        </span>
      </span>
      {info?.rate_limit_per_minute != null && (
        <span>
          Rate limit <span className="font-medium text-text-primary">{formatCount(info.rate_limit_per_minute)} / minute</span>
        </span>
      )}
    </div>
  );
}

function PromoRules() {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border-default px-4 py-3">
      <p className="text-caption font-medium text-text-primary">Rules every promotional SMS follows</p>
      <ul className="flex flex-col gap-1 text-caption text-text-secondary">
        {[
          'Skipped for merchants who opted out (by the STOP link or in their account)',
          'Sent only 9 AM to 9 PM Bangladesh time; later sends wait until 9 AM',
          'Sent from the promotional mask, never the Storeplix sender',
          'Ends with the STOP link footer — added automatically and counted in parts',
          'At most 2 per merchant per week',
        ].map((r) => (
          <li key={r} className="flex items-start gap-1.5">
            <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-success" />
            {r}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TypeRow({ type: t, onOpen }: { type: PlatformSmsMessageType; onOpen: (language: 'bn' | 'en') => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.admin.platformSms.messageTypes.update(t.type, { enabled }),
    onSuccess: (next) => {
      void qc.invalidateQueries({ queryKey: platformSmsKeys.messageTypes });
      toast(`${t.label} SMS ${next.enabled ? 'on' : 'off'}`);
    },
    onError: (e) => toast(smsErrorText(e), 'danger'),
  });
  const bn = t.templates.find((x) => x.language === 'bn');
  const en = t.templates.find((x) => x.language === 'en');
  const parts = Math.max(bn?.parts ?? 0, en?.parts ?? 0);
  return (
    <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 lg:flex-row lg:items-center" data-testid={`type-${t.type}`}>
      <div className="flex min-w-0 flex-col gap-1 lg:w-56 lg:shrink-0">
        <p className="flex items-center gap-1.5 text-body font-medium text-text-primary">
          {t.label}
          {t.locked && <Lock aria-label="Locked" className="size-3.5 text-text-muted" />}
        </p>
        <p className="text-caption text-text-muted">{t.trigger}</p>
        <span className="flex flex-wrap gap-1.5">
          {parts > 0 && (
            <Badge size="sm" tone="neutral">
              {parts} SMS
            </Badge>
          )}
          <span className="text-caption text-text-muted">{formatCount(t.sent_this_month)} this month</span>
        </span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {t.type === 'broadcast' ? (
          <p className="text-caption text-text-secondary">Composed per broadcast in the Broadcasts tab.</p>
        ) : (
          [bn, en].map(
            (tpl) =>
              tpl && (
                <button
                  key={tpl.language}
                  type="button"
                  onClick={() => onOpen(tpl.language)}
                  className="flex items-start gap-2 rounded-md border border-border-default px-2.5 py-1.5 text-left outline-none hover:bg-surface-subtle focus-visible:shadow-focus"
                >
                  <span className={cn('w-10 shrink-0 text-caption font-medium text-text-muted', tpl.language === 'bn' && 'font-bangla')}>{tpl.language === 'bn' ? 'বাংলা' : 'EN'}</span>
                  <span className={cn('line-clamp-2 min-w-0 flex-1 text-caption text-text-primary', tpl.language === 'bn' && 'font-bangla')}>{tpl.body}</span>
                  {tpl.is_custom && (
                    <Badge size="sm" tone="brand">
                      Edited
                    </Badge>
                  )}
                </button>
              ),
          )
        )}
      </div>
      <div className="flex items-center gap-3 lg:w-40 lg:justify-end">
        <Button size="sm" variant="ghost" onClick={() => onOpen('bn')}>
          {t.type === 'broadcast' ? 'Open' : t.editable ? 'Edit' : 'View'}
        </Button>
        {t.enabled === null ? (
          <span className="flex items-center gap-1 text-caption text-text-muted">
            <Lock aria-hidden className="size-3" /> Always on
          </span>
        ) : (
          <Toggle label={`${t.label} SMS`} checked={t.enabled} disabled={toggle.isPending} onChange={(v) => toggle.mutate(v)} />
        )}
      </div>
    </li>
  );
}

/** "{characters} characters · {parts} SMS parts" + a 3-segment bar (danger beyond 3 parts). */
export function PartMeter({ characters, parts, label }: { characters: number; parts: number; label?: string }) {
  const over = parts > SMS_TEMPLATE_MAX_PARTS;
  return (
    <div className="flex flex-col gap-1.5" data-testid="part-meter">
      <div className={cn('flex items-center justify-between text-body font-medium', over ? 'text-danger' : 'text-text-primary')}>
        <span>
          {characters} characters{label ? ` ${label}` : ''}
        </span>
        <span className={over ? 'text-danger' : 'text-brand-600'}>
          {parts} SMS {parts === 1 ? 'part' : 'parts'}
          {over ? ` — max ${SMS_TEMPLATE_MAX_PARTS}` : ''}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-1" aria-hidden>
        {[1, 2, 3].map((i) => (
          <span key={i} className={cn('h-1 rounded-full', over ? 'bg-danger' : i <= parts ? 'bg-brand-600' : 'bg-surface-subtle')} />
        ))}
      </div>
      <p className={cn('text-caption', over ? 'text-danger' : 'text-text-muted')}>
        <span className="font-bangla">বাংলা</span> uses Unicode: 70 characters per part (English: 160). Up to {SMS_TEMPLATE_MAX_PARTS} parts. Merge tags count at their sample length.
      </p>
    </div>
  );
}

export function TemplateEditor({ type: t, defaultLanguage, onClose }: { type: PlatformSmsMessageType; defaultLanguage: 'bn' | 'en'; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [language, setLanguage] = useState<'bn' | 'en'>(defaultLanguage);
  const tpl = (t.templates.find((x) => x.language === language) ?? t.templates[0]) as PlatformSmsTemplate;
  const [drafts, setDrafts] = useState<Record<'bn' | 'en', string>>(() => ({
    bn: t.templates.find((x) => x.language === 'bn')?.body ?? '',
    en: t.templates.find((x) => x.language === 'en')?.body ?? '',
  }));
  const [serverError, setServerError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [testing, setTesting] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null);
  const editable = t.editable;

  const body = drafts[language];
  const dirty = normalizeBody(body) !== normalizeBody(tpl.body);
  const count: TemplateCount = countTemplate(body, language);
  const problem = editable ? templateProblem(body, t.merge_fields, t.required_fields, count) : null;
  const debounced = useDebounced(body, PREVIEW_DEBOUNCE_MS);
  const previewEnabled = editable && dirty && !problem && debounced === body;
  const preview = useQuery({
    queryKey: [...platformSmsKeys.root, 'preview', t.type, language, debounced],
    queryFn: ({ signal }) => api.admin.platformSms.messageTypes.preview({ type: t.type, language, body: debounced }, { signal }),
    enabled: previewEnabled,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const shown = !dirty ? { text: tpl.preview, parts: tpl.parts, characters: Array.from(tpl.preview).length } : previewEnabled && preview.data && !preview.isPlaceholderData ? preview.data : null;
  const parts = shown?.parts ?? count.parts;
  const characters = shown?.characters ?? count.characters;

  useEffect(() => {
    if (caret.current !== null && textarea.current) {
      textarea.current.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  });

  const refresh = () => qc.invalidateQueries({ queryKey: platformSmsKeys.messageTypes });
  const save = useMutation({
    mutationFn: () => api.admin.platformSms.messageTypes.updateTemplate(t.type, language, { body: body.trim(), revision: tpl.revision }),
    onSuccess: (saved) => {
      setDrafts((d) => ({ ...d, [language]: saved.body }));
      void refresh();
      toast(saved.is_custom ? 'Template saved' : 'Template saved — it matches the default text');
    },
    onError: (e) => {
      if (isApiError(e) && e.code === 'revision_conflict') setConflict(true);
      else setServerError(smsErrorText(e));
    },
  });
  const reset = useMutation({
    mutationFn: () => api.admin.platformSms.messageTypes.resetTemplate(t.type, language),
    onSuccess: (saved) => {
      setConfirmReset(false);
      setDrafts((d) => ({ ...d, [language]: saved.body }));
      void refresh();
      toast('Template reset to the default text');
    },
    onError: (e) => {
      setConfirmReset(false);
      setServerError(smsErrorText(e));
    },
  });

  const setBody = (v: string) => {
    setServerError(null);
    setDrafts((d) => ({ ...d, [language]: v }));
  };
  const insert = (field: string) => {
    const el = textarea.current;
    const next = insertAt(body, field, el?.selectionStart ?? body.length, el?.selectionEnd ?? body.length);
    caret.current = next.caret;
    setBody(next.body);
    el?.focus();
  };

  const previewError = preview.isError ? smsErrorText(preview.error) : null;
  const errorText = serverError ?? (problem && problem.code !== 'empty' ? templateProblemText(problem) : null) ?? previewError;
  const tooLong = count.parts > SMS_TEMPLATE_MAX_PARTS || (isApiError(preview.error) && preview.error.code === 'platform_sms_template_too_long');
  const tag = dirty ? { label: 'Unsaved', tone: 'warning' as const } : tpl.is_custom ? { label: 'Edited', tone: 'brand' as const } : null;
  const groupLabel = { registration: 'Registration', billing: 'Invoice & billing', security: 'Login & security', promotional: 'Promotional' }[t.group];

  const footer = editable ? (
    <div className="flex w-full flex-wrap items-center gap-2">
      <Button variant="ghost" disabled={!tpl.is_custom && !dirty} onClick={() => (tpl.is_custom ? setConfirmReset(true) : setBody(tpl.default_body))}>
        Reset to default
      </Button>
      <span className="flex-1" />
      <Button variant="secondary" onClick={onClose}>
        Cancel
      </Button>
      <Button loading={save.isPending} disabled={!dirty || !!problem || tooLong || conflict} onClick={() => save.mutate()}>
        Save template
      </Button>
    </div>
  ) : (
    <div className="flex w-full items-center gap-2">
      <p className="flex flex-1 items-center gap-1.5 text-caption text-text-secondary">
        <Lock aria-hidden className="size-3.5" /> Locked: always on, the text can’t be changed.
      </p>
      <Button variant="secondary" onClick={onClose}>
        Close
      </Button>
    </div>
  );

  return (
    <>
      <Drawer
        open
        onClose={onClose}
        width={520}
        title={
          <span className="flex items-center gap-2">
            {editable ? 'Edit template' : 'Template'}
            <Badge size="sm" tone="neutral">
              {groupLabel}
            </Badge>
          </span>
        }
        description={`${t.label} · sent when ${t.trigger.charAt(0).toLowerCase()}${t.trigger.slice(1)}`}
        footer={footer}
      >
        <div className="flex flex-col gap-4 px-4 py-4 sm:px-5">
          <div className="flex flex-col gap-2">
            <span className="text-caption font-medium text-text-secondary">Language</span>
            <div role="group" aria-label="Template language" className="flex gap-2">
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
            {t.locked && <p className="text-caption text-text-muted">Codes are sent in English in both languages.</p>}
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <label htmlFor="platform-sms-template-body" className="flex-1 text-body font-medium text-text-primary">
                Message
              </label>
              {tag && (
                <Badge size="sm" tone={tag.tone}>
                  {tag.label}
                </Badge>
              )}
            </div>
            <textarea
              id="platform-sms-template-body"
              ref={textarea}
              value={body}
              readOnly={!editable}
              rows={5}
              aria-invalid={errorText ? true : undefined}
              onChange={(e) => setBody(e.target.value)}
              className={cn(
                'w-full resize-y rounded-control border bg-surface-card px-3 py-2.5 text-body text-text-primary outline-none read-only:bg-surface-subtle focus:border-brand-600 focus:shadow-focus',
                language === 'bn' && 'font-bangla leading-[22px]',
                tooLong ? 'border-danger' : 'border-border-default',
              )}
            />
            {editable && (
              <>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-caption text-text-muted">Insert</span>
                  {t.merge_fields.map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => insert(f)}
                      className="rounded-full bg-brand-50 px-2 py-0.5 text-caption font-medium text-brand-700 outline-none hover:bg-brand-100 focus-visible:shadow-focus"
                    >
                      {`{${f}}`}
                    </button>
                  ))}
                </div>
                <p className="text-caption text-text-muted">{'{otp}'} is only in the sign-in and verification texts, which can’t be edited. Links come from {'{link}'} only.</p>
              </>
            )}
          </div>
          <PartMeter characters={characters} parts={parts} />
          <div className="flex flex-col gap-2">
            <span className="text-caption font-medium text-text-secondary">Preview</span>
            <div className="flex flex-col gap-2 rounded-card bg-surface-subtle p-3">
              <p className="text-center text-caption text-text-secondary">
                <span className="block font-medium text-text-primary">{t.sender === 'promotional' ? 'Promotional mask' : 'Storeplix'}</span>
                Text message · now
              </p>
              <p data-testid="template-preview" className={cn('rounded-card bg-surface-card px-3 py-2.5 text-body break-words text-text-primary', language === 'bn' && 'font-bangla')}>
                {shown ? shown.text : preview.isFetching ? 'Updating preview…' : '—'}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="flex-1 text-caption text-text-muted">Sample: Nasrin · Mugdho Fashion · Growth plan · invoice SP-2026-001042</p>
              <Button size="sm" variant="ghost" onClick={() => setTesting(true)}>
                Send test to me
              </Button>
            </div>
          </div>
          {errorText && (
            <p role="alert" className="flex items-start gap-2 rounded-lg bg-danger-bg px-3 py-2.5 text-caption font-medium text-danger">
              <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              {errorText}
            </p>
          )}
          {conflict && (
            <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg bg-warning-bg px-3 py-2.5 text-caption font-medium text-text-primary">
              <span className="flex-1">Someone else changed this template.</span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setConflict(false);
                  void refresh();
                  onClose();
                }}
              >
                Reload
              </Button>
            </div>
          )}
        </div>
      </Drawer>
      <Dialog
        open={confirmReset}
        tone="danger"
        title="Reset to the default text?"
        description="Your edited text for this language is removed. Merchants get the standard message again."
        confirmLabel="Reset"
        loading={reset.isPending}
        onConfirm={() => reset.mutate()}
        onCancel={() => setConfirmReset(false)}
      />
      {testing && (
        <TestSmsDialog
          title={`Send “${t.label}” to me`}
          description={`${language === 'bn' ? 'বাংলা' : 'English'} version with sample data${editable && dirty ? ' (your unsaved text)' : ''}.`}
          onClose={() => setTesting(false)}
          send={(phone) => api.admin.platformSms.messageTypes.test(t.type, { language, phone, body: editable && dirty ? body.trim() : undefined })}
          renderResult={(r) => (
            <p role="status" className="rounded-lg bg-success-bg px-3 py-2.5 text-body text-text-primary">
              {r.status === 'failed' ? 'The test failed.' : `Test ${r.status === 'queued' ? 'queued' : 'sent'} to ${r.to_masked}`} · {r.parts} part{r.parts === 1 ? '' : 's'}
              {r.provider ? ` · via ${r.provider.name}` : ''}
            </p>
          )}
        />
      )}
    </>
  );
}
