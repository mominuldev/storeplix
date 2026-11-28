'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import type { InboxWidgetSession, InboxWidgetStart } from '@storeplix/types';
import { normalizeBdPhone } from '@/lib/checkout-form';
import { cleanOtpInput } from '@/lib/checkout-guard';
import { INBOX_COPY, inboxErrorText, tr, type Lang } from '@/lib/inbox-copy';
import { ATTACHMENT_ACCEPT, CODE_RE, NAME_MAX, POLL, SHOPPER_BODY_MAX, attachmentProblem, cleanBody } from '@/lib/inbox-shared';
import { Icon } from '@/themes/modern-commerce/components/icon';
import type { ChatWidgetConfig } from './chat-widget';
import { clientFetch, jsonPost, newClientId } from './client-api';
import { attachmentProblemText, Composer, FileChip } from './composer';
import { MessageList } from './message-list';
import { useFocusTrap } from './use-focus-trap';
import { useThread, type ThreadUrls } from './use-thread';

/** Product card data rendered by the PDP as `<span hidden data-sp-chat-product …>` (no JS on the page itself). */
export interface ChatProduct {
  slug: string;
  name: string;
  price: string;
  image: string | null;
}

export function readChatProduct(doc: Pick<Document, 'querySelector'>): ChatProduct | null {
  const el = doc.querySelector<HTMLElement>('[data-sp-chat-product]');
  const slug = el?.dataset.slug ?? '';
  const name = el?.dataset.name ?? '';
  if (!el || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || !name) return null;
  const image = el.dataset.image ?? '';
  return { slug, name: name.slice(0, 200), price: (el.dataset.price ?? '').slice(0, 40), image: /^(?:https:\/\/|\/)/.test(image) ? image : null };
}

const inputCls =
  'type-body-m h-[52px] w-full rounded-sf-md border border-line bg-surface px-4 text-ink outline-none placeholder:text-ink-muted focus:border-2 focus:border-brand aria-[invalid=true]:border-sale';

interface Props {
  config: ChatWidgetConfig;
  lang: Lang;
  session: InboxWidgetSession | null;
  onSession: (s: InboxWidgetSession | null) => void;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}

type Notice = { tone: 'info' | 'error'; text: string } | null;

/** Open chat (Figma 2125:9736 form · composed code step · 2125:10004 sent/thread · 2126:10484 mobile sheet). */
export default function ChatPanel({ config, lang, session, onSession, onClose, returnFocusRef }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [product, setProduct] = useState<ChatProduct | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [justSent, setJustSent] = useState<{ name: string; masked: string } | null>(null);
  const [unverifiedNote, setUnverifiedNote] = useState(session?.status === 'unverified');
  const [form, setForm] = useState({ name: '', phone: '', message: '' });

  useFocusTrap(panelRef, true, onClose, returnFocusRef);
  useEffect(() => setProduct(readChatProduct(document)), []);

  const step = !session ? 'form' : session.status === 'pending' ? 'code' : 'thread';
  const replyLine = [tr(INBOX_COPY.replyTime(config.replyTime), lang), config.hours].filter(Boolean).join(' · ');

  return (
    <>
      <div className="fixed inset-0 z-50 bg-inverse/48 sm:hidden" aria-hidden onClick={onClose} data-sp-chat-scrim />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={tr(INBOX_COPY.dialogLabel(config.shopName), lang)}
        tabIndex={-1}
        className="fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col overflow-hidden rounded-t-sf-xl bg-canvas shadow-e3 outline-none sm:inset-x-auto sm:right-8 sm:bottom-[102px] sm:max-h-[min(680px,calc(100dvh-134px))] sm:w-[380px] sm:rounded-sf-xl"
        data-sp-chat-panel={step}
      >
        <header className="flex shrink-0 items-center gap-3 bg-inverse py-4 pr-4 pl-5 text-paper">
          {config.logoUrl ? (
            <img src={config.logoUrl} alt="" className="size-8 shrink-0 rounded-sf-xs bg-surface object-contain" />
          ) : (
            <span aria-hidden className="type-label-m grid size-8 shrink-0 place-items-center rounded-full bg-brand text-on-brand">
              {config.shopName.slice(0, 1).toUpperCase()}
            </span>
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 id={titleId} className="type-label-m truncate">
              {config.shopName}
            </h2>
            <p className="type-body-s truncate opacity-90">{replyLine}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={tr(INBOX_COPY.close, lang)} className="grid size-8 shrink-0 place-items-center rounded-full hover:bg-paper/10">
            <Icon name="x" size={20} />
          </button>
        </header>

        {step === 'thread' && session ? (
          <ThreadStep
            config={config}
            lang={lang}
            session={session}
            product={product}
            justSent={justSent}
            unverifiedNote={unverifiedNote}
            onEnded={(code) => {
              setJustSent(null);
              setUnverifiedNote(false);
              setNotice({ tone: 'info', text: inboxErrorText({ status: 404, code }, lang) });
              onSession(null);
            }}
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
            {product ? <ProductContext product={product} lang={lang} /> : null}
            {notice ? <InlineNotice tone={notice.tone}>{notice.text}</InlineNotice> : null}
            {step === 'form' ? (
              <GuestForm
                lang={lang}
                product={product}
                values={form}
                onValues={setForm}
                onStarted={(start, name) => {
                  setNotice(null);
                  setForm((f) => ({ ...f, message: '' }));
                  setUnverifiedNote(start.status === 'unverified');
                  if (start.status === 'unverified') setJustSent(null);
                  onSession({ status: start.status === 'code_sent' ? 'pending' : 'unverified', name, phone_masked: start.phone_masked, unread_count: 0, resend_after: start.resend_after });
                }}
              />
            ) : session ? (
              <CodeStep
                lang={lang}
                session={session}
                onVerified={() => {
                  setJustSent({ name: session.name.split(/\s+/)[0] ?? session.name, masked: session.phone_masked });
                  onSession({ ...session, status: 'verified', resend_after: null });
                }}
                onChangeNumber={async () => {
                  await clientFetch('/api/chat/session', { method: 'DELETE' });
                  onSession(null);
                }}
                onEnded={(code) => {
                  setNotice({ tone: 'info', text: inboxErrorText({ status: 404, code }, lang) });
                  onSession(null);
                }}
              />
            ) : null}
          </div>
        )}
      </div>
    </>
  );
}

function InlineNotice({ tone, children }: { tone: 'info' | 'error' | 'ok'; children: ReactNode }) {
  const cls = tone === 'error' ? 'bg-accent-soft text-sale' : 'bg-sunken text-ink-secondary';
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`type-body-s flex items-start gap-2 rounded-sf-md px-3 py-2.5 ${cls}`}>
      <Icon name={tone === 'ok' ? 'check-circle' : 'info'} size={18} className={tone === 'ok' ? 'text-brand' : ''} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function ProductContext({ product, lang }: { product: ChatProduct; lang: Lang }) {
  return (
    <div className="flex items-center gap-2.5 rounded-sf-md bg-sunken py-2 pr-3 pl-2" data-sp-chat-context>
      {product.image ? <img src={product.image} alt="" className="size-10 shrink-0 rounded-sf-xs object-cover" /> : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="type-body-s text-ink-muted">{tr(INBOX_COPY.askingAbout, lang)}</p>
        <p className="type-label-s truncate text-ink">{[product.name, product.price].filter(Boolean).join(' · ')}</p>
      </div>
    </div>
  );
}

// ---------- guest form ----------
type FormErrors = Partial<Record<'name' | 'phone' | 'message' | 'file', string>>;

function GuestForm({
  lang,
  product,
  values,
  onValues,
  onStarted,
}: {
  lang: Lang;
  product: ChatProduct | null;
  values: { name: string; phone: string; message: string };
  onValues: (v: { name: string; phone: string; message: string }) => void;
  onStarted: (start: Omit<InboxWidgetStart, 'session_token'>, name: string) => void;
}) {
  const [errors, setErrors] = useState<FormErrors>({});
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [clientId] = useState(newClientId);
  const fileRef = useRef<HTMLInputElement>(null);
  const ids = { name: useId(), phone: useId(), message: useId() };

  const set = (k: 'name' | 'phone' | 'message', v: string) => onValues({ ...values, [k]: v });

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const name = cleanBody(values.name).replace(/\s+/g, ' ');
    const phone = normalizeBdPhone(values.phone);
    const message = cleanBody(values.message);
    const next: FormErrors = {};
    if (!name || [...name].length > NAME_MAX) next.name = tr(INBOX_COPY.nameRequired, lang);
    if (!phone) next.phone = tr(INBOX_COPY.phoneInvalid, lang);
    if (!message) next.message = tr(INBOX_COPY.messageRequired, lang);
    else if ([...message].length > SHOPPER_BODY_MAX) next.message = tr(INBOX_COPY.messageTooLong(SHOPPER_BODY_MAX), lang);
    setErrors(next);
    setFailure(null);
    if (Object.keys(next).length) {
      const firstBad = (['name', 'phone', 'message'] as const).find((k) => next[k]);
      if (firstBad) document.getElementById(ids[firstBad])?.focus();
      return;
    }
    const fd = new FormData();
    fd.append('name', name);
    fd.append('phone', values.phone);
    fd.append('message', message);
    fd.append('client_id', clientId);
    fd.append('website', String(new FormData(e.currentTarget).get('website') ?? ''));
    if (product) fd.append('product_slug', product.slug);
    fd.append('page_path', window.location.pathname);
    if (file) fd.append('file', file, file.name);
    setBusy(true);
    const r = await clientFetch<Omit<InboxWidgetStart, 'session_token'>>('/api/chat/start', { method: 'POST', body: fd });
    setBusy(false);
    if (r.ok && 'data' in r && r.data) {
      setFile(null);
      onStarted(r.data, name);
      return;
    }
    const error = r.ok ? { status: 502, code: 'error' } : r.error;
    const d = error.details ?? {};
    if (error.code === 'validation_failed' && ('name' in d || 'phone' in d || 'message' in d || 'file' in d)) {
      setErrors({
        name: 'name' in d ? tr(INBOX_COPY.nameRequired, lang) : undefined,
        phone: 'phone' in d ? tr(INBOX_COPY.phoneInvalid, lang) : undefined,
        message: 'message' in d ? tr(INBOX_COPY.messageRequired, lang) : undefined,
        file: 'file' in d ? tr(INBOX_COPY.fileType, lang) : undefined,
      });
      return;
    }
    setFailure(inboxErrorText(error, lang));
  };

  const pick = (f: File | undefined) => {
    if (!f) return;
    const p = attachmentProblem(f);
    setErrors((e) => ({ ...e, file: p ? attachmentProblemText(p, lang) : undefined }));
    setFile(p ? null : f);
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3" data-sp-chat-form>
      <div className="flex flex-col gap-2">
        <label htmlFor={ids.name} className="type-label-s text-ink">
          {tr(INBOX_COPY.name, lang)}
        </label>
        <input id={ids.name} data-autofocus value={values.name} onChange={(e) => set('name', e.target.value)} maxLength={NAME_MAX} autoComplete="name" aria-invalid={Boolean(errors.name)} aria-describedby={errors.name ? `${ids.name}-e` : undefined} className={inputCls} />
        {errors.name ? (
          <p id={`${ids.name}-e`} className="type-body-s text-sale">
            {errors.name}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor={ids.phone} className="type-label-s text-ink">
          {tr(INBOX_COPY.mobile, lang)}
        </label>
        <input id={ids.phone} value={values.phone} onChange={(e) => set('phone', e.target.value)} type="tel" inputMode="tel" autoComplete="tel-national" placeholder="01XXX-XXXXXX" maxLength={20} aria-invalid={Boolean(errors.phone)} aria-describedby={`${ids.phone}-h`} className={inputCls} />
        <p id={`${ids.phone}-h`} className={`type-body-s ${errors.phone ? 'text-sale' : 'text-ink-muted'}`}>
          {errors.phone ?? tr(INBOX_COPY.mobileHelp, lang)}
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={ids.message} className="type-label-s text-ink">
          {tr(INBOX_COPY.message, lang)}
        </label>
        <textarea id={ids.message} value={values.message} onChange={(e) => set('message', e.target.value)} rows={3} aria-invalid={Boolean(errors.message)} aria-describedby={errors.message ? `${ids.message}-e` : undefined} className="type-body-m h-[84px] w-full resize-none rounded-sf-md border border-line bg-surface p-3 text-ink outline-none focus:border-2 focus:border-brand aria-[invalid=true]:border-sale" />
        {errors.message ? (
          <p id={`${ids.message}-e`} className="type-body-s text-sale">
            {errors.message}
          </p>
        ) : null}
      </div>
      {/* Honeypot (P88E-13): hidden from people and assistive tech; bots that fill it get a fake success from the API. */}
      <div aria-hidden className="absolute -left-[9999px] h-px w-px overflow-hidden">
        <label>
          Website
          <input name="website" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
        </label>
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <input ref={fileRef} type="file" accept={ATTACHMENT_ACCEPT} className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => pick(e.target.files?.[0])} />
          <button type="button" onClick={() => fileRef.current?.click()} className="type-label-s flex items-center gap-2 text-brand hover:underline">
            <Icon name="paperclip" size={18} />
            {tr(INBOX_COPY.addFile, lang)}
          </button>
          <span className="flex-1" />
          <span className="type-body-s text-ink-muted">{tr(INBOX_COPY.fileLimit, lang)}</span>
        </div>
        {file ? <FileChip file={file} onRemove={() => setFile(null)} lang={lang} /> : null}
        {errors.file ? <p className="type-body-s text-sale">{errors.file}</p> : null}
      </div>
      {failure ? <InlineNotice tone="error">{failure}</InlineNotice> : null}
      <button type="submit" disabled={busy} className="type-label-m flex h-[52px] items-center justify-center gap-2 rounded-control bg-brand px-7 text-on-brand hover:brightness-110 disabled:opacity-60" data-sp-chat-send>
        {busy ? tr(INBOX_COPY.sending, lang) : tr(INBOX_COPY.send, lang)}
        <Icon name="paper-plane" />
      </button>
      <p className="type-body-s text-ink-muted">{tr(INBOX_COPY.privacy, lang)}</p>
    </form>
  );
}

// ---------- code step ----------
function useCountdown(initial: number | null) {
  const [left, setLeft] = useState(initial ?? 0);
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(t);
  }, [left]);
  return [left, setLeft] as const;
}

function CodeStep({
  lang,
  session,
  onVerified,
  onChangeNumber,
  onEnded,
}: {
  lang: Lang;
  session: InboxWidgetSession;
  onVerified: () => void;
  onChangeNumber: () => Promise<void>;
  onEnded: (code: string) => void;
}) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useCountdown(session.resend_after ?? 60);
  const inputId = useId();

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    if (!CODE_RE.test(code)) {
      setError(tr(INBOX_COPY.codeRequired, lang));
      return;
    }
    setBusy(true);
    const r = await clientFetch('/api/chat/verify', jsonPost({ code }));
    setBusy(false);
    if (r.ok) return onVerified();
    if (r.error.code === 'inbox_session_invalid' || r.error.code === 'inbox_unavailable') return onEnded(r.error.code);
    setCode('');
    setError(inboxErrorText(r.error, lang));
  };

  const resend = async () => {
    setInfo(null);
    setError(null);
    const r = await clientFetch<InboxWidgetSession | { resent: true }>('/api/chat/resend', jsonPost());
    if (r.ok) {
      const after = r.ok && 'data' in r && r.data && 'resend_after' in r.data ? r.data.resend_after : null;
      setLeft(after ?? 60);
      setInfo(tr(INBOX_COPY.resent, lang));
      return;
    }
    if (r.error.code === 'inbox_session_invalid') return onEnded(r.error.code);
    if (r.error.code === 'rate_limited' && typeof r.error.details?.retry_after === 'number') setLeft(r.error.details.retry_after);
    setError(inboxErrorText(r.error, lang));
  };

  return (
    <form onSubmit={verify} noValidate className="flex flex-col gap-3" data-sp-chat-code>
      <div className="flex flex-col gap-1">
        <p className="type-label-m text-ink">{tr(INBOX_COPY.codeTitle, lang)}</p>
        <p className="type-body-s text-ink-secondary">{tr(INBOX_COPY.codeHelp(session.phone_masked), lang)}</p>
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor={inputId} className="type-label-s text-ink">
          {tr(INBOX_COPY.codeLabel, lang)}
        </label>
        <input
          id={inputId}
          data-autofocus
          value={code}
          onChange={(e) => setCode(cleanOtpInput(e.target.value))}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          aria-invalid={Boolean(error)}
          aria-describedby={`${inputId}-m`}
          className={`${inputCls} tracking-[0.3em]`}
        />
        <p id={`${inputId}-m`} role={error ? 'alert' : undefined} className={`type-body-s ${error ? 'text-sale' : 'text-ink-muted'}`}>
          {error ?? info ?? tr(INBOX_COPY.codeWaiting, lang)}
        </p>
      </div>
      <button type="submit" disabled={busy} className="type-label-m flex h-[52px] items-center justify-center gap-2 rounded-control bg-brand px-7 text-on-brand hover:brightness-110 disabled:opacity-60">
        {busy ? tr(INBOX_COPY.verifying, lang) : tr(INBOX_COPY.verify, lang)}
      </button>
      <div className="flex items-center justify-between gap-3">
        <button type="button" onClick={resend} disabled={left > 0} className="type-label-s text-brand hover:underline disabled:text-ink-muted disabled:no-underline" data-sp-chat-resend>
          {left > 0 ? tr(INBOX_COPY.resendIn(left), lang) : tr(INBOX_COPY.resend, lang)}
        </button>
        <button type="button" onClick={() => void onChangeNumber()} className="type-label-s text-brand hover:underline">
          {tr(INBOX_COPY.changeNumber, lang)}
        </button>
      </div>
    </form>
  );
}

// ---------- thread ----------
const CHAT_URLS: ThreadUrls = {
  list: (after) => `/api/chat/messages${after ? `?after=${encodeURIComponent(after)}` : ''}`,
  send: '/api/chat/messages',
  seen: '/api/chat/seen',
};

function ThreadStep({
  config,
  lang,
  session,
  product,
  justSent,
  unverifiedNote,
  onEnded,
}: {
  config: ChatWidgetConfig;
  lang: Lang;
  session: InboxWidgetSession;
  product: ChatProduct | null;
  justSent: { name: string; masked: string } | null;
  unverifiedNote: boolean;
  onEnded: (code: string) => void;
}) {
  const t = useThread({ urls: CHAT_URLS, interval: POLL.widgetOpen, active: true, lang, onEnded });
  const scrollRef = useRef<HTMLDivElement>(null);
  const count = t.messages.length + t.pending.length;
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count, t.status]);
  const attachmentUrl = useCallback((id: string) => `/api/chat/attachments/${encodeURIComponent(id)}`, []);
  const greeting = useMemo(
    () => (
      <div className="type-body-s max-w-[85%] rounded-[12px] border border-line bg-surface px-3.5 py-2.5 whitespace-pre-wrap text-ink" data-sp-chat-greeting>
        {config.greeting ?? tr(INBOX_COPY.greeting, lang)}
      </div>
    ),
    [config.greeting, lang],
  );

  return (
    <>
      <div ref={scrollRef} onPointerDown={t.touch} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4" data-sp-chat-body>
        {product ? <ProductContext product={product} lang={lang} /> : null}
        {t.offline ? <InlineNotice tone="error">{tr(INBOX_COPY.offline, lang)}</InlineNotice> : null}
        {t.status === 'loading' ? (
          <p className="type-body-s text-ink-muted" role="status">
            {tr(INBOX_COPY.loading, lang)}
          </p>
        ) : t.status === 'error' ? (
          <InlineNotice tone="error">
            {tr(INBOX_COPY.loadError, lang)}{' '}
            <button type="button" onClick={t.reload} className="underline">
              {tr(INBOX_COPY.retry, lang)}
            </button>
          </InlineNotice>
        ) : (
          <MessageList messages={t.messages} pending={t.pending} tone="surface" lang={lang} attachmentUrl={attachmentUrl} onRetry={t.retry} lead={greeting} />
        )}
        {justSent ? (
          <InlineNotice tone="ok">{tr(INBOX_COPY.thanks(justSent.name, justSent.masked, config.replyTime), lang)}</InlineNotice>
        ) : unverifiedNote || session.status === 'unverified' ? (
          <InlineNotice tone="info">{tr(INBOX_COPY.unverified, lang)}</InlineNotice>
        ) : null}
      </div>
      <Composer variant="chat" lang={lang} error={t.sendError} disabled={t.status === 'ended'} onSend={t.send} onInteract={t.touch} />
    </>
  );
}
