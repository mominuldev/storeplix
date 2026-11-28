import { isApiError } from '@storeplix/api-client';
import type { SmsOverview, SmsTemplate, SmsTemplateKey, SmsTemplatePreviewInput } from '@storeplix/types';
import { SMS_MERGE_FIELD_LABELS, SMS_TEMPLATE_EVENTS, SMS_TEMPLATE_MAX_PARTS } from '@storeplix/types';
import { Badge, Button, Chip, cn, Dialog, Drawer, Skeleton, Toggle } from '@storeplix/ui';
import { AlertTriangle, Lock } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useStoreScope } from '../catalog/scope';
import { useReadOnly } from '../impersonation/hooks';
import { ErrorBlock } from '../catalog/states';
import { toast } from '../online-store/components/Toast';
import { useSaveSettings, useStoreSettings } from '../settings/commerceSettings';
import { Panel } from './components';
import { smsErrorText } from './errors';
import { useResetTemplate, useSaveTemplate, useSmsInvalidate, useSmsTemplates, useTemplatePreview } from './queries';
import { countTemplate, insertAt, normalizeBody, TEMPLATE_WHEN, templateProblem, templateProblemText, type SampleContext, type TemplateCount } from './sms';

// Figma Templates 2075:50213 (§12.2): one row per key with bn + en previews, Edited/Default, Edit, the shared
// notification switch (P89A-10); checkout OTP locked. Edit panel: language chips, textarea, Insert chips (at the
// cursor), live part counter mirroring the server's sample render, debounced server preview (authoritative), inline
// errors, Reset to default, PUT with `revision` (409 → reload).

export const PREVIEW_DEBOUNCE_MS = 400;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Store values the sample render needs (§7.3). */
export function useSampleContext(overview: SmsOverview | undefined): SampleContext {
  const { store } = useStoreScope();
  const settings = useStoreSettings();
  return {
    shop: store?.name ?? settings.data?.identity.name ?? 'Shop',
    orderPrefix: settings.data?.commerce?.order_prefix ?? 'SP',
    host: store?.primary_domain ?? settings.data?.identity.primary_domain ?? '',
    footer: null,
    masked: overview?.sender.type === 'masked',
  };
}

export function TemplatesTab({ overview, canEdit, openKey, onOpenKey }: { overview: SmsOverview | undefined; canEdit: boolean; openKey: SmsTemplateKey | null; onOpenKey: (k: SmsTemplateKey | null) => void }) {
  const templates = useSmsTemplates();
  const save = useSaveSettings('SMS settings saved.');
  const invalidate = useSmsInvalidate();
  const rows = useMemo(() => {
    const list = templates.data ?? [];
    const keys: SmsTemplateKey[] = [...SMS_TEMPLATE_EVENTS, 'checkout_otp'];
    return keys.map((k) => ({ key: k, bn: list.find((t) => t.key === k && t.language === 'bn'), en: list.find((t) => t.key === k && t.language === 'en') })).filter((r) => r.bn || r.en);
  }, [templates.data]);
  const open = openKey ? rows.find((r) => r.key === openKey) : undefined;

  return (
    <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
      <Panel title="Order SMS templates" description="Every message has a বাংলা and an English version. Customers get the language of their order." className="min-w-0 flex-1">
        {templates.isPending ? (
          <div className="flex flex-col gap-3">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-20 rounded-lg" />
            ))}
          </div>
        ) : templates.isError ? (
          <ErrorBlock title="We couldn’t load your templates" error={templates.error} onRetry={() => void templates.refetch()} />
        ) : (
          <ul aria-label="SMS templates" className="flex flex-col">
            {rows.map(({ key, bn, en }) => {
              const any = (bn ?? en)!;
              const editable = any.editable;
              const custom = !!(bn?.is_custom || en?.is_custom);
              const selected = key === openKey;
              return (
                <li key={key} aria-label={any.label} className={cn('flex flex-col gap-3 border-b border-border-default px-2.5 py-3.5 last:border-b-0 md:flex-row md:items-center', selected && 'rounded-card border border-brand-100 bg-brand-50')}>
                  <div className="flex flex-col gap-0.5 md:w-[150px] md:shrink-0">
                    <span className="text-body font-semibold text-text-primary">{any.label}</span>
                    <span className="text-caption text-text-secondary">When: {TEMPLATE_WHEN[key]}</span>
                    {editable ? (
                      <Badge size="sm" tone={custom ? 'brand' : 'neutral'} className="mt-1 self-start">
                        {custom ? 'Edited' : 'Default'}
                      </Badge>
                    ) : (
                      <>
                        <span className="mt-1 flex items-center gap-1 text-caption text-text-secondary">
                          <Lock aria-hidden className="size-3" /> Read-only
                        </span>
                        <Link to="/orders/fraud-guard" className="text-caption font-medium text-brand-600 hover:underline">
                          Managed by Fake order guard
                        </Link>
                      </>
                    )}
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    {[bn, en].map((t) =>
                      t ? (
                        <div key={t.language} className="flex items-center gap-2">
                          <span className={cn('w-12 shrink-0 text-caption text-text-secondary', t.language === 'bn' && 'font-bangla')}>{t.language === 'bn' ? 'বাংলা' : 'English'}</span>
                          <span className={cn('min-w-0 flex-1 truncate rounded-md bg-surface-canvas px-2 py-1 text-caption text-text-primary', t.language === 'bn' && 'font-bangla')} title={t.preview.text}>
                            {t.preview.text}
                          </span>
                          <span className="shrink-0 text-caption text-text-secondary">{t.preview.parts} SMS</span>
                        </div>
                      ) : null,
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-3 self-end md:self-center">
                    {editable ? (
                      <>
                        <button
                          type="button"
                          onClick={() => onOpenKey(key)}
                          className="rounded-sm text-body font-medium text-brand-600 outline-none hover:underline focus-visible:shadow-focus"
                          aria-label={`${canEdit ? 'Edit' : 'View'} ${any.label}`}
                        >
                          {selected ? 'Editing' : canEdit ? 'Edit' : 'View'}
                        </button>
                        {any.enabled !== null && (
                          <Toggle
                            label={`SMS: ${any.label}`}
                            checked={any.enabled}
                            disabled={!canEdit || save.isPending}
                            onChange={(v) => save.mutate({ notifications: { customer_sms: { [key]: v } } }, { onSuccess: () => void invalidate() })}
                          />
                        )}
                      </>
                    ) : (
                      <span className="flex items-center gap-1 text-body text-text-secondary">
                        <Lock aria-hidden className="size-3.5" /> Locked
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
      {open && open.bn && open.en && open.bn.editable && (
        <TemplateEditor key={open.key} bn={open.bn} en={open.en} overview={overview} canEdit={canEdit} onClose={() => onOpenKey(null)} defaultLanguage={overview?.language ?? 'bn'} />
      )}
    </div>
  );
}

/** Media query hook: the editor is a side panel on lg+, a full-screen sheet below. */
function useWide(): boolean {
  const query = '(min-width: 1024px)';
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const on = () => setWide(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return wide;
}

export function TemplateEditor({
  bn,
  en,
  overview,
  canEdit,
  onClose,
  defaultLanguage,
}: {
  bn: SmsTemplate;
  en: SmsTemplate;
  overview: SmsOverview | undefined;
  canEdit: boolean;
  onClose: () => void;
  defaultLanguage: 'bn' | 'en';
}) {
  const [language, setLanguage] = useState<'bn' | 'en'>(defaultLanguage);
  const current = language === 'bn' ? bn : en;
  const [drafts, setDrafts] = useState<Record<'bn' | 'en', string>>({ bn: bn.body, en: en.body });
  const [conflict, setConflict] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null);
  const ctx = useSampleContext(overview);
  const save = useSaveTemplate();
  const reset = useResetTemplate();
  const wide = useWide();
  const readOnly = useReadOnly();
  const invalidate = useSmsInvalidate();

  const body = drafts[language];
  const dirty = normalizeBody(body) !== normalizeBody(current.body);
  const count = countTemplate(body, ctx, language);
  const problem = templateProblem(body, current.merge_fields, current.required_fields, count);
  const debounced = useDebounced(body, PREVIEW_DEBOUNCE_MS);
  const previewInput: SmsTemplatePreviewInput | null = canEdit && !problem && debounced === body ? { key: current.key, language, body: debounced } : null;
  const preview = useTemplatePreview(canEdit ? previewInput : null);
  const previewError = preview.isError && preview.error ? smsErrorText(preview.error) : null;
  const shown = canEdit && preview.data && !preview.isPlaceholderData ? preview.data : !dirty ? current.preview : null;
  const parts = shown ? shown.parts : count.parts;
  const characters = shown ? shown.characters : count.characters;

  useEffect(() => {
    if (caret.current !== null && textarea.current) {
      textarea.current.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  });

  const setBody = (v: string) => {
    setServerError(null);
    setDrafts((d) => ({ ...d, [language]: v }));
  };
  const insert = (field: string) => {
    const el = textarea.current;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    const next = insertAt(body, field, start, end);
    caret.current = next.caret;
    setBody(next.body);
    el?.focus();
  };

  const onSave = () => {
    setServerError(null);
    save.mutate(
      { key: current.key, language, body: body.trim(), revision: current.revision },
      {
        onSuccess: (t) => {
          setDrafts((d) => ({ ...d, [language]: t.body }));
          toast(t.is_custom ? 'Template saved.' : 'Template saved — it matches the default text.');
        },
        onError: (e) => {
          if (isApiError(e) && e.code === 'revision_conflict') setConflict(true);
          else setServerError(smsErrorText(e));
        },
      },
    );
  };
  const onReset = () => {
    reset.mutate(
      { key: current.key, language },
      {
        onSuccess: (t) => {
          setConfirmReset(false);
          setDrafts((d) => ({ ...d, [language]: t.body }));
          toast('Template reset to the default text.');
        },
        onError: (e) => {
          setConfirmReset(false);
          setServerError(smsErrorText(e));
        },
      },
    );
  };

  const errorText = serverError ?? (problem && problem.code !== 'empty' ? templateProblemText(problem) : null) ?? previewError;
  const tooLong = count.parts > SMS_TEMPLATE_MAX_PARTS || (isApiError(preview.error) && preview.error.code === 'sms_template_too_long');
  const tag = dirty ? { label: 'Unsaved', tone: 'warning' as const } : current.is_custom ? { label: 'Edited', tone: 'brand' as const } : null;

  const content = (
    <div className="flex flex-col gap-4">
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
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <label htmlFor="sms-template-body" className="flex-1 text-body font-medium text-text-primary">
            Message
          </label>
          {tag && (
            <Badge size="sm" tone={tag.tone}>
              {tag.label}
            </Badge>
          )}
        </div>
        <textarea
          id="sms-template-body"
          ref={textarea}
          value={body}
          readOnly={!canEdit}
          rows={5}
          aria-invalid={errorText ? true : undefined}
          onChange={(e) => setBody(e.target.value)}
          className={cn(
            'w-full resize-y rounded-control border bg-surface-card px-3 py-2.5 text-body text-text-primary outline-none focus:border-brand-600 focus:shadow-focus read-only:bg-surface-subtle',
            language === 'bn' && 'font-bangla leading-[22px]',
            tooLong ? 'border-danger' : 'border-border-default',
          )}
        />
        {canEdit && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-caption text-text-muted">Insert</span>
            {current.merge_fields.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => insert(f)}
                title={SMS_MERGE_FIELD_LABELS[f]}
                className="rounded-full bg-brand-50 px-2 py-0.5 text-caption font-medium text-brand-700 outline-none hover:bg-brand-100 focus-visible:shadow-focus"
              >
                {`{${f}}`}
              </button>
            ))}
          </div>
        )}
      </div>
      <PartMeter characters={characters} parts={parts} count={count} />
      <div className="flex flex-col gap-2">
        <span className="text-caption font-medium text-text-secondary">Preview</span>
        <div className="flex flex-col gap-2 rounded-card bg-surface-subtle p-3">
          <p className="text-center text-caption text-text-secondary">
            <span className="block font-medium text-text-primary">{ctx.masked && overview?.sender.sender_id ? overview.sender.sender_id : 'Storeplix'}</span>
            Text message · now
          </p>
          <p data-testid="template-preview" className={cn('rounded-card bg-surface-card px-3 py-2.5 text-body text-text-primary', language === 'bn' && 'font-bangla')}>
            {shown ? shown.text : preview.isFetching ? 'Updating preview…' : '—'}
          </p>
        </div>
        <p className="text-caption text-text-muted">
          Sample order: Nasrin · {ctx.orderPrefix}-1042 · Tk 1,770.{' '}
          {ctx.masked ? 'The shop-name prefix is dropped because you use your own sender ID.' : `“${ctx.shop}: ” is added because you use the Storeplix sender.`}
        </p>
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
              void invalidate();
              onClose();
            }}
          >
            Reload
          </Button>
        </div>
      )}
    </div>
  );

  const footer = canEdit ? (
    <div className="flex w-full flex-wrap items-center gap-2">
      <Button variant="ghost" disabled={!current.is_custom && !dirty} onClick={() => (current.is_custom ? setConfirmReset(true) : setBody(current.default_body))}>
        Reset to default
      </Button>
      <span className="flex-1" />
      <Button variant="secondary" onClick={onClose}>
        Cancel
      </Button>
      <Button loading={save.isPending} disabled={!dirty || !!problem || tooLong || save.isPending || conflict} onClick={onSave}>
        Save
      </Button>
    </div>
  ) : (
    <div className="flex w-full items-center gap-2">
      <p className="flex-1 text-caption text-text-secondary">{readOnly ? 'Read-only support session. Changes are disabled.' : 'Only owners and managers can edit messages.'}</p>
      <Button variant="secondary" onClick={onClose}>
        Close
      </Button>
    </div>
  );

  const title = canEdit ? 'Edit template' : 'Template';
  const description = `${current.label} · sent when ${TEMPLATE_WHEN[current.key]}`;
  return (
    <>
      {wide ? (
        <section aria-label={title} className="flex flex-col gap-4 rounded-card border border-border-default bg-surface-card px-6 py-[22px] shadow-elevation-1 lg:w-[340px] lg:shrink-0">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-body-lg font-medium text-text-primary">{title}</h2>
            <p className="text-caption text-text-secondary">{description}</p>
          </div>
          {content}
          {footer}
        </section>
      ) : (
        <Drawer open side="bottom" title={title} description={description} onClose={onClose} footer={footer}>
          {content}
        </Drawer>
      )}
      <Dialog
        open={confirmReset}
        tone="danger"
        title="Reset to the default text?"
        description="Your edited text for this language is removed. Customers get the standard message again."
        confirmLabel="Reset"
        loading={reset.isPending}
        onConfirm={onReset}
        onCancel={() => setConfirmReset(false)}
      />
    </>
  );
}

/** "{characters} characters · {parts} SMS parts" + a 3-segment bar (danger beyond 3 parts). */
export function PartMeter({ characters, parts, count }: { characters: number; parts: number; count: TemplateCount }) {
  const over = parts > SMS_TEMPLATE_MAX_PARTS;
  return (
    <div className="flex flex-col gap-1.5" data-testid="part-meter">
      <div className={cn('flex items-center justify-between text-body font-medium', over ? 'text-danger' : 'text-text-primary')}>
        <span>{characters} characters</span>
        <span>
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
        <span className="font-bangla">বাংলা</span> uses Unicode: 70 characters per part (English: 160). Up to {SMS_TEMPLATE_MAX_PARTS} parts. Merge tags count at their usual length.
        {count.encoding === 'ucs2' && over ? ` This message needs ${parts} parts.` : ''}
      </p>
    </div>
  );
}
