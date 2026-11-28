import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { apiCall, LARAVEL_LOG, mailMark, tinker, urls, type ApiResult, type Session } from './api';
import { png, storefrontKey } from './catalog';
import { browserHost, mapStoreHost, randomIp, randomPhone, type CommerceShop } from './commerce';
import { purchasingShop, retryLocked, spath } from './purchasing';
import { cleanupSmsShop, msisdn, overview, seedAllowanceUsage, sentSince, smsMark, tinyPdf, type SentSms } from './sms';

/**
 * Phase 8.8e helpers (PHASE-8-8E-CONTRACT §4–§13, §16 QA): Inbox channels, conversations, messages, actions, saved
 * replies, the storefront widget + order Messages (server-to-server like the Next.js route handlers), magic links, the
 * signed `fake` inbound-email webhook, and the dashboard / widget selectors. Real API, no mocks.
 *
 * Local stack: `SMS_DRIVER=log` (code + reply SMS are `sms.log_driver` lines in laravel.log), `INBOUND_MAIL_DRIVER=fake`
 * + `INBOX_MAIL_DOMAIN` (the email channel is `available`), `MAIL_MAILER=log` (reply / assignment mails in the log), a
 * queue worker (reply SMS job, inbound email job, outbound email job). The reply SMS job is delayed 120 s (P88E-12):
 * `hurryInboxJobs()` makes delayed inbox jobs due now on the database / redis queue, else the specs wait it out.
 *
 * Shapes follow `packages/types` (InboxSettings, InboxConversation, InboxMessage, InboxWidgetStart, …).
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const INBOX = '/inbox';
export const SAVED_REPLIES = '/inbox/saved-replies';
export const INBOUND_FAKE_KEY = process.env.INBOUND_MAIL_FAKE_KEY ?? 'fake-inbound-signing-key';
export const INBOX_MAIL_DOMAIN = process.env.INBOX_MAIL_DOMAIN ?? 'in.storeplix.test';
const ULID = /^[0-9a-z]{26}$/i;
const guard = (...ids: string[]) => ids.forEach((id) => { if (!ULID.test(id)) throw new Error(`bad id ${id}`); });

const call = (as: Session, method: string, path: string, json?: unknown, headers?: Record<string, string>) =>
  retryLocked(() => apiCall(as, method, path, { ...(json === undefined ? {} : { json }), ...(headers ? { headers } : {}) }));

export async function ok(r: ApiResult, status: number, what: string): Promise<Json> {
  expect(r.status, `${what}: ${r.text.slice(0, 500)}`).toBe(status);
  return r.json.data as Json;
}

const ip = (s: Session, rest = '') => spath(s, `/inbox${rest}`);
const cpath = (s: Session, id: string, rest = '') => ip(s, `/conversations/${id}${rest}`);

// ---------------------------------------------------------------------------------------------
// Channel settings (§4)
// ---------------------------------------------------------------------------------------------
export const settingsRaw = (s: Session, as: Session = s) => call(as, 'GET', ip(s, '/settings'));
export const settings = async (s: Session, as: Session = s) => ok(await settingsRaw(s, as), 200, 'inbox settings');
export const patchSettingsRaw = (s: Session, change: Json, as: Session = s) => call(as, 'PATCH', ip(s, '/settings'), change);
export async function patchSettings(s: Session, change: Json): Promise<Json> {
  const cur = await settings(s);
  return ok(await patchSettingsRaw(s, { revision: cur.revision, ...change }), 200, 'patch inbox settings');
}
export const rotateRaw = (s: Session, as: Session = s) => call(as, 'POST', ip(s, '/settings/email-address/rotate'), {});

export interface Channels {
  web_chat?: boolean;
  order_messages?: boolean;
  email?: boolean;
}
export async function setChannels(s: Session, c: Channels): Promise<Json> {
  const change: Json = {};
  if (c.web_chat !== undefined) change.web_chat_enabled = c.web_chat;
  if (c.order_messages !== undefined) change.order_messages_enabled = c.order_messages;
  if (c.email !== undefined) change.email_enabled = c.email;
  return patchSettings(s, change);
}

// ---------------------------------------------------------------------------------------------
// Summary, list, thread (§5, §6)
// ---------------------------------------------------------------------------------------------
export const summaryRaw = (s: Session, as: Session = s, etag?: string) => call(as, 'GET', ip(s, '/summary'), undefined, etag ? { 'If-None-Match': etag } : undefined);
export const summary = async (s: Session, as: Session = s) => ok(await summaryRaw(s, as), 200, 'inbox summary');

export function listQuery(f: { status?: string; scope?: string; channel?: string[]; q?: string; cursor?: string } = {}): string {
  const p = new URLSearchParams();
  if (f.status) p.set('filter[status]', f.status);
  if (f.scope) p.set('filter[scope]', f.scope);
  if (f.channel?.length) p.set('filter[channel]', f.channel.join(','));
  if (f.q) p.set('q', f.q);
  if (f.cursor) p.set('cursor', f.cursor);
  return p.toString();
}
export const conversationsRaw = (s: Session, query = '', as: Session = s, etag?: string) =>
  call(as, 'GET', ip(s, `/conversations${query ? `?${query}` : ''}`), undefined, etag ? { 'If-None-Match': etag } : undefined);
export async function conversations(s: Session, f: Parameters<typeof listQuery>[0] = {}, as: Session = s): Promise<{ data: Json[]; meta: Json }> {
  const r = await conversationsRaw(s, listQuery(f), as);
  expect(r.status, r.text.slice(0, 400)).toBe(200);
  return { data: r.json.data as Json[], meta: r.json.meta as Json };
}
export const conversationRaw = (s: Session, id: string, as: Session = s) => call(as, 'GET', cpath(s, id));
export const conversation = async (s: Session, id: string, as: Session = s) => ok(await conversationRaw(s, id, as), 200, `conversation ${id}`);
export const messagesRaw = (s: Session, id: string, query = '', as: Session = s, etag?: string) =>
  call(as, 'GET', cpath(s, id, `/messages${query ? `?${query}` : ''}`), undefined, etag ? { 'If-None-Match': etag } : undefined);
export async function messages(s: Session, id: string, as: Session = s): Promise<Json[]> {
  return (await ok(await messagesRaw(s, id, '', as), 200, 'messages')) as unknown as Json[];
}
export const sendRaw = (s: Session, id: string, body: Json, as: Session = s) => call(as, 'POST', cpath(s, id, '/messages'), { client_id: randomUUID(), ...body });
export async function reply(s: Session, id: string, text: string, extra: Json = {}, as: Session = s): Promise<Json> {
  return ok(await sendRaw(s, id, { kind: 'reply', body: text, ...extra }, as), 201, 'send reply');
}
export async function note(s: Session, id: string, text: string, as: Session = s): Promise<Json> {
  return ok(await sendRaw(s, id, { kind: 'note', body: text }, as), 201, 'send note');
}
export const assignRaw = (s: Session, id: string, assigneeId: string | null, as: Session = s) => call(as, 'POST', cpath(s, id, '/assign'), { assignee_id: assigneeId });
export const statusRaw = (s: Session, id: string, status: 'open' | 'pending' | 'closed', as: Session = s) => call(as, 'POST', cpath(s, id, '/status'), { status });
export const blockRaw = (s: Session, id: string, block = true, as: Session = s) => call(as, 'POST', cpath(s, id, block ? '/block' : '/unblock'), {});
export const linkOrderRaw = (s: Session, id: string, orderId: string | null, as: Session = s) => call(as, 'PUT', cpath(s, id, '/order'), { order_id: orderId });
export const readRaw = (s: Session, id: string, last: string, as: Session = s) => call(as, 'POST', cpath(s, id, '/read'), { last_read_message_id: last });
export const deleteRaw = (s: Session, id: string, as: Session = s) => call(as, 'DELETE', cpath(s, id));
export const assigneesRaw = (s: Session, as: Session = s) => call(as, 'GET', ip(s, '/assignees'));
export const attachmentLinkRaw = (s: Session, attachmentId: string, as: Session = s) => call(as, 'GET', ip(s, `/attachments/${attachmentId}/link`));

/** Multipart member upload (`inbox.manage`). */
export function uploadRaw(s: Session, file: { name: string; mimeType: string; buffer: Buffer }, as: Session = s): Promise<ApiResult> {
  return retryLocked(() => apiCall(as, 'POST', ip(s, '/attachments'), { multipart: { file } }));
}

/** Every conversation of the store (scope all, every status, first page each). */
export async function allConversations(s: Session, as: Session = s): Promise<Json[]> {
  const out: Json[] = [];
  for (const status of ['open', 'pending', 'closed']) out.push(...(await conversations(s, { status, scope: 'all' }, as)).data);
  return out;
}

/** The single conversation of a channel matching `pred` (scope all, any status). */
export async function findConversation(s: Session, pred: (c: Json) => boolean, what: string, timeout = 30_000): Promise<Json> {
  let hit: Json | undefined;
  await expect
    .poll(
      async () => {
        for (const status of ['open', 'pending', 'closed']) {
          const r = await conversations(s, { status, scope: 'all' });
          hit = r.data.find(pred);
          if (hit) return true;
        }
        return false;
      },
      { timeout, intervals: [500, 1_000, 2_000], message: `conversation: ${what}` },
    )
    .toBe(true);
  return hit!;
}

// ----- Saved replies (§8) -----
export const savedRepliesRaw = (s: Session, query = '', as: Session = s) => call(as, 'GET', ip(s, `/saved-replies${query ? `?${query}` : ''}`));
export const createSavedReplyRaw = (s: Session, body: Json, as: Session = s) => call(as, 'POST', ip(s, '/saved-replies'), body);
export async function createSavedReply(s: Session, body: Json): Promise<Json> {
  return ok(await createSavedReplyRaw(s, { show_as_chip: false, ...body }), 201, 'create saved reply');
}
export const renderSavedReplyRaw = (s: Session, conversationId: string, replyId: string, as: Session = s) =>
  call(as, 'POST', cpath(s, conversationId, `/saved-replies/${replyId}/render`), {});

// ---------------------------------------------------------------------------------------------
// Storefront API (§9.2, §10), server-to-server with the storefront key, like the Next.js route handlers
// ---------------------------------------------------------------------------------------------
export interface SfInboxOptions {
  json?: unknown;
  form?: Record<string, string | { name: string; type: string; buffer: Buffer }>;
  session?: string | null;
  orderAccess?: string | null;
  ip?: string;
  etag?: string;
  headers?: Record<string, string>;
}

/** `path` is relative to /api/v1/storefront. */
export async function sfInbox(host: string, method: string, path: string, o: SfInboxOptions = {}): Promise<ApiResult> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Storefront-Key': storefrontKey(),
    'X-Storefront-Host': host,
    'X-Storefront-Client-Ip': o.ip ?? randomIp(),
    ...(o.session ? { 'X-Inbox-Session': o.session } : {}),
    ...(o.orderAccess ? { 'X-Order-Access': o.orderAccess } : {}),
    ...(o.etag ? { 'If-None-Match': o.etag } : {}),
    ...(o.headers ?? {}),
  };
  let body: BodyInit | undefined;
  if (o.form) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(o.form)) {
      if (typeof v === 'string') fd.append(k, v);
      else fd.append(k, new Blob([new Uint8Array(v.buffer)], { type: v.type }), v.name);
    }
    body = fd;
  } else if (o.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(o.json);
  }
  const doFetch = async (): Promise<ApiResult> => {
    const res = await fetch(`${urls.api}/api/v1/storefront${path}`, { method, headers, body });
    const text = await res.text();
    let json: Json = {};
    try {
      json = text ? (JSON.parse(text) as Json) : {};
    } catch {
      json = { raw: text };
    }
    return { status: res.status, json, text, headers: Object.fromEntries(res.headers) };
  };
  return retryLocked(doFetch);
}

export interface ChatStart {
  name?: string;
  phone?: string;
  message?: string;
  productSlug?: string;
  pagePath?: string;
  honeypot?: string;
  file?: { name: string; type: string; buffer: Buffer };
  ip?: string;
}
export function startChatRaw(host: string, c: ChatStart = {}): Promise<ApiResult> {
  const form: SfInboxOptions['form'] = {
    name: c.name ?? 'Nusrat Jahan',
    phone: c.phone ?? randomPhone(),
    message: c.message ?? 'Is the kurta available in L?',
    client_id: randomUUID(),
    website: c.honeypot ?? '',
  };
  if (c.productSlug) form.product_slug = c.productSlug;
  if (c.pagePath) form.page_path = c.pagePath;
  if (c.file) form.file = c.file;
  return sfInbox(host, 'POST', '/inbox/sessions', { form, ip: c.ip });
}
export const verifyRaw = (host: string, session: string, code: string, ipAddr?: string) => sfInbox(host, 'POST', '/inbox/sessions/verify', { json: { code }, session, ip: ipAddr });
export const resendRaw = (host: string, session: string) => sfInbox(host, 'POST', '/inbox/sessions/resend', { json: {}, session });
export const widgetSessionRaw = (host: string, session: string) => sfInbox(host, 'GET', '/inbox/session', { session });
export const shopperMessagesRaw = (host: string, session: string, after?: string) => sfInbox(host, 'GET', `/inbox/messages${after ? `?after=${after}` : ''}`, { session });
export function shopperSendRaw(host: string, session: string, body: string, file?: { name: string; type: string; buffer: Buffer }, ipAddr?: string): Promise<ApiResult> {
  const form: SfInboxOptions['form'] = { body, client_id: randomUUID() };
  if (file) form.file = file;
  return sfInbox(host, 'POST', '/inbox/messages', { form, session, ip: ipAddr });
}
export const shopperSeenRaw = (host: string, session: string) => sfInbox(host, 'POST', '/inbox/messages/seen', { json: {}, session });
export const shopperAttachmentRaw = (host: string, session: string, id: string) => sfInbox(host, 'GET', `/inbox/attachments/${id}`, { session });
export const magicLinkRaw = (host: string, code: string) => sfInbox(host, 'POST', `/inbox/links/${code}`, { json: {} });
export const sfConfigRaw = (host: string) => sfInbox(host, 'GET', '/config');

// Order messages (§10)
export const trackRaw = (host: string, number: string, phone: string) => sfInbox(host, 'POST', '/orders/track', { json: { number, phone } });
export async function orderAccess(host: string, number: string, phone: string): Promise<string> {
  const r = await trackRaw(host, number, phone);
  expect(r.status, r.text.slice(0, 400)).toBe(200);
  const token = r.json.data?.messages?.access_token as string | undefined;
  expect(token, 'track → messages.access_token (order messages on)').toBeTruthy();
  return token!;
}
export const orderMessagesRaw = (host: string, access: string, after?: string) => sfInbox(host, 'GET', `/orders/messages${after ? `?after=${after}` : ''}`, { orderAccess: access });
export function orderSendRaw(host: string, access: string, body: string, file?: { name: string; type: string; buffer: Buffer }): Promise<ApiResult> {
  const form: SfInboxOptions['form'] = { body, client_id: randomUUID() };
  if (file) form.file = file;
  return sfInbox(host, 'POST', '/orders/messages', { form, orderAccess: access });
}
export const orderAccessViewRaw = (host: string, access: string) => sfInbox(host, 'GET', '/orders/access', { orderAccess: access });

// ---------------------------------------------------------------------------------------------
// SMS (log driver): code and reply SMS with the magic link
// ---------------------------------------------------------------------------------------------
const SIX = /(?<!\d)(\d{6})(?!\d)/;
export const MAGIC = /\/m\/([A-Za-z0-9_-]{16,64})/;
export { smsMark };

/** SMS lines to `phone` (local `01…` or `8801…`) after `mark`. */
export const smsTo = (mark: number, phone: string): SentSms[] => sentSince(mark).filter((m) => m.to.replace(/\D/g, '').endsWith(msisdn(phone).slice(-10)));

/** The 6-digit chat code texted to `phone` after `mark` (the newest one). */
export async function readCode(mark: number, phone: string, timeout = 30_000): Promise<string> {
  let code: string | null = null;
  await expect
    .poll(
      () => {
        const hits = smsTo(mark, phone).filter((m) => SIX.test(m.text) && !MAGIC.test(m.text));
        code = hits.at(-1)?.text.match(SIX)?.[1] ?? null;
        return code !== null;
      },
      { timeout, intervals: [300, 700, 1_500], message: `chat code SMS to ${phone} (SMS_DRIVER=log? queue worker?)` },
    )
    .toBe(true);
  return code!;
}

/** The reply SMS (with `/m/{code}`) texted to `phone` after `mark`. */
export async function readReplySms(mark: number, phone: string, timeout = 200_000): Promise<{ sms: SentSms; code: string }> {
  let hit: SentSms | undefined;
  await expect
    .poll(
      () => {
        hurryInboxJobs();
        hit = smsTo(mark, phone).find((m) => MAGIC.test(m.text));
        return hit !== undefined;
      },
      { timeout, intervals: [2_000, 3_000, 5_000], message: `reply SMS with a magic link to ${phone} (job delayed 120 s; queue worker?)` },
    )
    .toBe(true);
  return { sms: hit!, code: hit!.text.match(MAGIC)![1]! };
}

/**
 * Makes delayed Inbox jobs (SendInboxReplySms, 120 s) due now. Test-only: database queue → `jobs.available_at`; redis
 * queue → the `*:delayed` sorted sets. No-op on other drivers (the spec then waits for the real delay).
 */
export function hurryInboxJobs(): void {
  try {
    tinker(
      [
        `$c=config('queue.default'); $n=0;`,
        `if($c==='database'){ $n=DB::table(config('queue.connections.database.table','jobs'))->where('payload','like','%Inbox%')->where('available_at','>',time())->update(['available_at'=>time()]); }`,
        `elseif($c==='redis'){ $r=Illuminate\\Support\\Facades\\Redis::connection(config('queue.connections.redis.connection','default')); $p=config('database.redis.options.prefix',''); foreach(['sms','default','webhooks','mail'] as $q){ $k='queues:'.$q.':delayed'; foreach($r->zrange($k,0,-1) as $job){ if(str_contains($job,'Inbox')){ $r->zadd($k,time(),$job); $n++; } } } }`,
        `echo 'hurried:'.$n;`,
      ].join(' '),
    );
  } catch {
    /* best effort */
  }
}

/** Uses up this month's transactional allowance (no credits are bought), so the next shop SMS can't be afforded. */
export async function exhaustSmsAllowance(s: Session): Promise<void> {
  const ov = await overview(s);
  const left = ov.allowance?.transactional?.remaining as number | null | undefined;
  if (typeof left === 'number' && left > 0) seedAllowanceUsage(s, left);
}

// ---------------------------------------------------------------------------------------------
// Inbound email (§11.2): the `fake` driver signs exactly like Mailgun with INBOUND_MAIL_FAKE_KEY
// ---------------------------------------------------------------------------------------------
export interface InboundMail {
  to: string;
  from: string;
  fromName?: string;
  subject?: string;
  text?: string;
  messageId?: string;
  inReplyTo?: string;
  spf?: 'pass' | 'fail' | 'none';
  headers?: Array<[string, string]>;
  attachments?: Array<{ name: string; type: string; buffer: Buffer }>;
  /** signature overrides for the negative tests */
  key?: string;
  timestamp?: number;
  token?: string;
  signature?: string;
}

export function signInbound(timestamp: string, token: string, key = INBOUND_FAKE_KEY): string {
  return createHmac('sha256', key).update(`${timestamp}${token}`).digest('hex');
}

export async function inboundEmailRaw(m: InboundMail, driver = 'fake'): Promise<ApiResult> {
  const timestamp = String(m.timestamp ?? Math.floor(Date.now() / 1000));
  const token = m.token ?? randomBytes(25).toString('hex');
  const fd = new FormData();
  const fields: Record<string, string> = {
    timestamp,
    token,
    signature: m.signature ?? signInbound(timestamp, token, m.key),
    recipient: m.to,
    sender: m.from,
    from: m.fromName ? `"${m.fromName}" <${m.from}>` : m.from,
    To: m.to,
    subject: m.subject ?? 'Question about my order',
    'body-plain': m.text ?? 'Hello, when will my parcel arrive?',
    'Message-Id': m.messageId ?? `<${randomUUID()}@mail.e2e.storeplix.test>`,
    'X-Mailgun-Spf': m.spf ?? 'pass',
    'message-headers': JSON.stringify(m.headers ?? []),
  };
  if (m.inReplyTo) fields['In-Reply-To'] = m.inReplyTo;
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  (m.attachments ?? []).forEach((a, i) => fd.append(`attachment-${i + 1}`, new Blob([new Uint8Array(a.buffer)], { type: a.type }), a.name));
  if (m.attachments?.length) fd.append('attachment-count', String(m.attachments.length));
  const res = await fetch(`${urls.api}/api/v1/webhooks/inbound-email/${driver}`, { method: 'POST', headers: { Accept: 'application/json' }, body: fd });
  const text = await res.text();
  let json: Json = {};
  try {
    json = text ? (JSON.parse(text) as Json) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, text, headers: Object.fromEntries(res.headers) };
}

// ---------------------------------------------------------------------------------------------
// Mail (MAIL_MAILER=log): one laravel.log entry per message, headers as written by Symfony Mailer
// ---------------------------------------------------------------------------------------------
export { mailMark };

/** Raw log entries of mails to `to` written after `mark` (quoted-printable soft breaks removed). */
export function mailsTo(mark: number, to: string): string[] {
  if (!existsSync(LARAVEL_LOG)) return [];
  const buf = readFileSync(LARAVEL_LOG);
  const tail = buf.subarray(Math.min(mark, buf.length)).toString('utf8');
  return tail
    .split(/\n(?=\[\d{4}-\d{2}-\d{2} )/)
    .filter((e) => new RegExp(`^To: .*${to.replace(/[.+]/g, '\\$&')}`, 'mi').test(e))
    .map((e) => e.replace(/=\r?\n/g, ''));
}

export async function waitMail(mark: number, to: string, pred: (entry: string) => boolean, what: string, timeout = 45_000): Promise<string> {
  let hit: string | undefined;
  await expect
    .poll(() => (hit = mailsTo(mark, to).find(pred)) !== undefined, { timeout, intervals: [500, 1_000, 2_000], message: `${what} (MAIL_MAILER=log? queue worker?)` })
    .toBe(true);
  return hit!;
}

/** A header value of a logged mail entry (first match), e.g. `Reply-To`, `In-Reply-To`. */
export function header(entry: string, name: string): string | null {
  // RFC 5322 folding: continuation lines start with whitespace (long "Name <address>" values are folded).
  const unfolded = entry.replace(/\r?\n[ \t]+/g, ' ');
  // the first header shares its line with the log prefix ("[time] local.DEBUG: From: …")
  return unfolded.match(new RegExp(`^(?:\\[[^\\]]+\\] \\S+: )?${name}: (.*)$`, 'mi'))?.[1]?.trim() ?? null;
}

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------
export const photo = (name = 'size-chart.png') => ({ name, type: 'image/png', mimeType: 'image/png', buffer: png(48, [40, 120, 200]) });
export const pdf = (name = 'invoice.pdf') => ({ name, type: 'application/pdf', mimeType: 'application/pdf', buffer: tinyPdf() });
/** A "PNG" that is really a script (sniffing must refuse it). */
export const fakePng = () => ({ name: 'evil.png', type: 'image/png', mimeType: 'image/png', buffer: Buffer.from('<?php echo 1; ?><script>alert(1)</script>') });
export const bigPdf = () => {
  const b = Buffer.alloc(5 * 1024 * 1024 + 512, 0x20);
  tinyPdf().copy(b);
  return { name: 'too-big.pdf', type: 'application/pdf', mimeType: 'application/pdf', buffer: b };
};

/**
 * A throwaway published shop (Starter: transactional SMS allowance, custom roles need Growth → pass `growth`) with
 * `{slug}.localhost` added for the browser and made primary (links in SMS / emails point at it), and the channels
 * switched on as asked. Always `cleanupInboxShop()`.
 */
export async function inboxShop(label: string, channels: Channels = { web_chat: true, order_messages: true, email: true }, plan: 'free' | 'starter' | 'growth' = 'starter'): Promise<CommerceShop> {
  const shop = await purchasingShop(label, plan, 10);
  try {
    browserHost(shop);
    mapStoreHost(shop);
    if (Object.keys(channels).length) await setChannels(shop.s, channels);
    return shop;
  } catch (e) {
    cleanupInboxShop(shop);
    throw e;
  }
}

/**
 * Cleanup for a throwaway inbox shop: `inbox_attachments.media_id → media` is ON DELETE RESTRICT, so the tenant cascade
 * can fail once anything was attached. Test-only: remove THIS e2e tenant's inbox rows first (refused unless its only
 * owner is an @e2e.storeplix.test address), then the SMS cleanup (ledger / sender IDs) and the tenant itself.
 */
export function cleanupInboxShop(shop: CommerceShop | undefined): void {
  if (!shop) return;
  guard(shop.s.tenantId);
  if (!/^[a-z0-9.+-]+@e2e\.storeplix\.test$/.test(shop.t.email)) throw new Error('refusing');
  try {
    tinker(
      [
        `$t='${shop.s.tenantId}'; $e='${shop.t.email}';`,
        `$owners=DB::table('tenant_users')->join('users','users.id','=','tenant_users.user_id')->where('tenant_users.tenant_id',$t)->where('tenant_users.role','owner')->pluck('users.email')->all();`,
        `if($owners===[$e]){ foreach(['inbox_attachments','inbox_magic_links','inbox_widget_sessions','inbox_reads','inbox_messages','inbox_conversations','inbox_saved_replies','inbox_settings'] as $tb){ if(Illuminate\\Support\\Facades\\Schema::hasTable($tb)){ DB::table($tb)->where('tenant_id',$t)->delete(); } } echo 'ok'; }`,
      ].join(' '),
    );
  } catch {
    /* tables missing on an old API: the tenant cleanup below still runs */
  }
  cleanupSmsShop(shop);
}

/** The store's inbound address (email channel on) — `shop-{key}@{domain}`. */
export async function storeAddress(s: Session): Promise<string> {
  const st = await settings(s);
  const a = st.channels?.email?.address as string | null;
  expect(a, 'email channel address').toMatch(/^shop-[a-z2-7]{12}@/);
  return a!;
}

/** Verified web chat through the API: start → code from the log → verify. Returns the session token + phone. */
export async function verifiedChat(shop: CommerceShop, o: ChatStart = {}): Promise<{ session: string; phone: string; start: Json }> {
  const phone = o.phone ?? randomPhone();
  const mark = smsMark();
  const start = await startChatRaw(shop.apiHost, { ...o, phone });
  expect(start.status, start.text.slice(0, 400)).toBe(201);
  expect(start.json.data.status, 'code SMS sent (allowance available?)').toBe('code_sent');
  const session = start.json.data.session_token as string;
  const code = await readCode(mark, phone);
  const v = await verifyRaw(shop.apiHost, session, code);
  expect(v.status, v.text.slice(0, 400)).toBe(200);
  return { session, phone, start: start.json.data as Json };
}

/** Orders with Messages: a COD order placed with `phone`. */
export { randomPhone };

// ---------------------------------------------------------------------------------------------
// Dashboard UI (§5–§8)
// ---------------------------------------------------------------------------------------------
export const mUrl = (path = '') => `${urls.merchant}${path}`;

export async function openInbox(page: Page, query = ''): Promise<void> {
  await page.goto(mUrl(`${INBOX}${query ? `?${query.replace(/^\?/, '')}` : ''}`));
  // Below lg a selected thread replaces the list and hides the page header (one pane at a time, 2124:1509).
  await expect(page.getByRole('heading', { name: 'Inbox', level: 1 }).or(page.getByRole('button', { name: 'Back to conversations' }))).toBeVisible({ timeout: 20_000 });
}
export const openThread = (page: Page, conversationId: string, extra = '') => openInbox(page, `c=${conversationId}${extra ? `&${extra}` : ''}`);

export const listRegion = (page: Page): Locator => page.getByRole('list', { name: 'Conversation list' });
export const row = (page: Page, text: string | RegExp): Locator => listRegion(page).getByRole('listitem').filter({ hasText: text });
export const statusChip = (page: Page, label: 'Open' | 'Pending' | 'Closed'): Locator => page.getByRole('group', { name: 'Status' }).getByRole('button', { name: new RegExp(`^${label}`) });
export const thread = (page: Page): Locator => page.getByLabel('Messages', { exact: true });
export const replyBox = (page: Page): Locator => page.getByRole('textbox', { name: /^(Reply|Internal note)$/ });
export const sendButton = (page: Page): Locator => page.getByRole('button', { name: 'Send', exact: true });
export const modeButton = (page: Page, mode: 'Reply' | 'Internal note'): Locator => page.getByRole('radiogroup', { name: 'Message type' }).getByRole('radio', { name: mode });
export const assignButton = (page: Page): Locator => page.getByRole('button', { name: /^Assignee: / });
export const actionsMenu = (page: Page): Locator => page.getByRole('button', { name: 'Conversation actions' });
export const channelsDrawer = (page: Page): Locator => page.getByRole('dialog', { name: 'Channels' });
export const channelCard = (scope: Page | Locator, title: 'Website chat' | 'Order messages' | 'Email replies'): Locator => scope.getByRole('region', { name: title });

/** Types a reply / note and sends it with the Send button; waits for the API 201. */
export async function sendFromComposer(page: Page, text: string, mode: 'Reply' | 'Internal note' = 'Reply'): Promise<void> {
  await modeButton(page, mode).click();
  await replyBox(page).fill(text);
  const sent = page.waitForResponse((r) => r.request().method() === 'POST' && /\/inbox\/conversations\/[^/]+\/messages$/.test(new URL(r.url()).pathname) && r.status() < 300);
  await sendButton(page).click();
  await sent;
}

// ---------------------------------------------------------------------------------------------
// Storefront widget UI (§9.3)
// ---------------------------------------------------------------------------------------------
export const launcher = (page: Page): Locator => page.locator('[data-sp-chat-launcher]');
export const chatPanel = (page: Page): Locator => page.getByRole('dialog', { name: /^Chat with / });
export const chatThread = (page: Page): Locator => page.locator('[data-sp-chat-thread]');
export const orderCard = (page: Page): Locator => page.locator('[data-sp-order-messages]');

/** Opens a shop page and waits for the launcher (the storefront config is revalidated after a channel switch). */
export async function gotoWithWidget(page: Page, shop: CommerceShop, path = '/', timeout = 30_000): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.goto(`${shop.storefront}${path}`);
        return launcher(page).isVisible();
      },
      { timeout, intervals: [1_000, 2_000, 3_000], message: `chat launcher on ${shop.localHost}${path} (web_chat on? storefront config revalidated?)` },
    )
    .toBe(true);
}

/**
 * Waits until `target` shows in the chat panel. The open widget should poll every 5 s (§12), but in `next dev` (React
 * strict mode) the loop dies after the first fetch (QA 8.8e bug: `schedule()` of the unmounted effect clears the shared
 * timer before checking `cancelled`), so this closes and reopens the panel between checks (a fresh mount fetches once).
 */
export async function waitInChat(page: Page, target: Locator, timeout = 45_000): Promise<void> {
  await expect
    .poll(
      async () => {
        if (await target.isVisible()) return true;
        if (await chatPanel(page).isVisible()) await page.getByRole('button', { name: 'Close chat' }).first().click();
        await launcher(page).click();
        await chatPanel(page).waitFor({ state: 'visible' });
        await page.waitForTimeout(1_500);
        return target.isVisible();
      },
      { timeout, intervals: [2_000, 3_000, 5_000] },
    )
    .toBe(true);
}

/** Same for the order Messages card (10 s poll, same hook): reloads the page between checks. */
export async function waitInOrderCard(page: Page, target: Locator, timeout = 45_000): Promise<void> {
  await expect
    .poll(
      async () => {
        if (await target.isVisible()) return true;
        const u = new URL(page.url());
        if (u.pathname === '/track') await page.goto(`${u.origin}/track?view=messages`); // the result comes back from sp_order_access
        else await page.reload();
        await orderCard(page).waitFor({ state: 'visible' });
        await page.waitForTimeout(1_500);
        return target.isVisible();
      },
      { timeout, intervals: [2_000, 3_000, 5_000] },
    )
    .toBe(true);
}

/** Fills the guest form in the open panel and sends it. */
export async function fillGuestForm(page: Page, o: { name: string; phone: string; message: string; file?: { name: string; mimeType: string; buffer: Buffer } }): Promise<void> {
  const p = chatPanel(page);
  await p.getByLabel('Your name').fill(o.name);
  await p.getByLabel('Mobile number').fill(o.phone);
  await p.getByLabel('Message', { exact: true }).fill(o.message);
  if (o.file) await p.locator('[data-sp-chat-form] input[type="file"]').setInputFiles(o.file);
  await p.getByRole('button', { name: 'Send message' }).click();
}

/** Puts a chat session cookie into the browser (as the route handler would after a verify / magic link). */
export async function useChatSession(context: BrowserContext, shop: CommerceShop, token: string): Promise<void> {
  await context.addCookies([
    { name: 'sp_chat', value: token, domain: shop.localHost, path: '/', httpOnly: true, sameSite: 'Lax' },
    { name: 'sp_chat_on', value: '1', domain: shop.localHost, path: '/', sameSite: 'Lax' },
  ]);
}
