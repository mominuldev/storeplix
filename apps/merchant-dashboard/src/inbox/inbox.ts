import type {
  CustomerRisk,
  InboxAttachment,
  InboxChannel,
  InboxConversation,
  InboxConversationSummary,
  InboxListFilters,
  InboxMergeTag,
  InboxMessage,
  InboxScope,
  InboxStatus,
} from '@storeplix/types';
import { INBOX_ATTACHMENT_MIMES, INBOX_CHANNELS, INBOX_LIMITS, INBOX_MERGE_TAGS, INBOX_STATUSES } from '@storeplix/types';
import type { BadgeTone } from '@storeplix/ui';
import { can, type PermissionHolder } from '../lib/permissions';

// PHASE-8-8E §5–§8, §12 pure rules for the Inbox page: URL filters, row/thread labels, message merging for polling,
// read marking, attachment checks, the `/` saved-reply trigger and merge-tag checks. Server responses stay authoritative.

// ----- Permissions (§2) -----
/** Page + nav: `inbox.manage`. */
export const canUseInbox = (m: PermissionHolder) => can.has(m, 'inbox.manage');
/** Channel switches and the email address: `settings.manage`. */
export const canEditChannels = (m: PermissionHolder) => can.has(m, 'settings.manage');

// ----- URL state (`/inbox?c=&status=&scope=&channel=&q=`) -----
export interface InboxUrlState {
  conversation: string | null;
  status: InboxStatus;
  scope: InboxScope;
  channel: InboxChannel | null;
  q: string;
}

const SCOPES: readonly InboxScope[] = ['mine_unassigned', 'mine', 'unassigned', 'all'];
export const SCOPE_LABELS: Record<InboxScope, string> = { mine_unassigned: 'Mine & unassigned', mine: 'Mine', unassigned: 'Unassigned', all: 'Everyone' };
export const CHANNEL_FILTER_LABELS: Record<InboxChannel, string> = { web_chat: 'Website chat', order: 'Order messages', email: 'Email' };
export const STATUS_LABELS: Record<InboxStatus, string> = { open: 'Open', pending: 'Pending', closed: 'Closed' };
export const STATUS_TONES: Record<InboxStatus, BadgeTone> = { open: 'info', pending: 'warning', closed: 'neutral' };

export function parseInboxUrl(p: URLSearchParams): InboxUrlState {
  const status = p.get('status');
  const scope = p.get('scope');
  const channel = p.get('channel');
  return {
    conversation: p.get('c') || null,
    status: (INBOX_STATUSES as readonly string[]).includes(status ?? '') ? (status as InboxStatus) : 'open',
    scope: (SCOPES as readonly string[]).includes(scope ?? '') ? (scope as InboxScope) : 'mine_unassigned',
    channel: (INBOX_CHANNELS as readonly string[]).includes(channel ?? '') ? (channel as InboxChannel) : null,
    q: p.get('q') ?? '',
  };
}

/** Back to query params; defaults are left out so `/inbox` stays clean. */
export function inboxSearch(s: InboxUrlState): URLSearchParams {
  const p = new URLSearchParams();
  if (s.conversation) p.set('c', s.conversation);
  if (s.status !== 'open') p.set('status', s.status);
  if (s.scope !== 'mine_unassigned') p.set('scope', s.scope);
  if (s.channel) p.set('channel', s.channel);
  if (s.q) p.set('q', s.q);
  return p;
}

/** API filters; `q` only from 2 characters (§5). */
export function listFilters(s: Pick<InboxUrlState, 'status' | 'scope' | 'channel' | 'q'>): InboxListFilters {
  const q = s.q.trim();
  return { status: s.status, scope: s.scope, channel: s.channel ? [s.channel] : undefined, q: q.length >= 2 ? q : undefined };
}

export const hasListFilters = (s: Pick<InboxUrlState, 'scope' | 'channel' | 'q'>) => s.scope !== 'mine_unassigned' || !!s.channel || s.q.trim().length >= 2;

// ----- Labels -----
/** "now", "6 min", "3 h", "Yesterday", "12 Oct" (list rows, Figma 2118:51165). */
export function shortTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = Math.max(0, now - t);
  if (diff < 60_000) return 'now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} min`;
  const d = new Date(t);
  const today = new Date(now);
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay || diff < 6 * 3600_000) return `${Math.floor(diff / 3600_000)} h`;
  const yesterday = new Date(now - 86_400_000);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** "10:14" (24-hour clock for bubbles). */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** "Today, 10:12" / "12 Oct, 10:12". */
export function dayTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const today = new Date(now).toDateString() === d.toDateString();
  return `${today ? 'Today' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${clockTime(iso)}`;
}

/** First-response seconds → "2 min" / "1 h 5 min" / "—". */
export function durationLabel(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  const min = Math.round(seconds / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  if (h < 48) return rest ? `${h} h ${rest} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}

export const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** Row title: "Rubel Hossain · GS-1042". */
export const rowTitle = (c: Pick<InboxConversationSummary, 'contact' | 'order'>) => (c.order ? `${c.contact.name} · ${c.order.number}` : c.contact.name);

/** Row second line: preview, then the assignee or "Unassigned" (Figma). */
export function rowPreview(c: Pick<InboxConversationSummary, 'preview' | 'assignee' | 'status'>): { text: string; who: string } {
  return { text: c.preview, who: c.assignee ? firstName(c.assignee.name) : 'Unassigned' };
}

/** Thread header subline: "Website chat · from /products/linen-kurta", "Order message · GS-1046", "Email · Re: …". */
export function threadSubline(c: Pick<InboxConversation, 'channel' | 'order' | 'source_path' | 'subject' | 'context'>): string {
  if (c.channel === 'web_chat') {
    if (c.context) return `Website chat · from the ${c.context.name} page`;
    return c.source_path ? `Website chat · from ${c.source_path}` : 'Website chat';
  }
  if (c.channel === 'order') return c.order ? `Order message · ${c.order.number}` : 'Order message';
  return c.subject ? `Email · ${c.subject}` : 'Email';
}

export const SENDS_TO: Record<InboxChannel, string> = { web_chat: 'Sends to website chat', order: 'Sends to the order page', email: 'Sends by email' };

/** Text of a system row (§6.4). `you` = the signed-in member's user id. */
export function systemText(m: Pick<InboxMessage, 'system'>, you?: string | null): string {
  const s = m.system;
  if (!s) return '';
  const actor = s.actor ? (s.actor.id === you ? 'You' : firstName(s.actor.name)) : 'Store Plix';
  const assignee = s.assignee ? (s.assignee.id === s.actor?.id ? (actor === 'You' ? 'yourself' : 'themselves') : firstName(s.assignee.name)) : '';
  switch (s.event) {
    case 'assigned':
      return `${actor} assigned this to ${assignee || 'a teammate'}`;
    case 'unassigned':
      return `${actor} moved this back to the shared queue`;
    case 'pending':
      return `${actor} marked this pending`;
    case 'closed':
      return `${actor} closed this conversation`;
    case 'reopened':
      return s.actor ? `${actor} reopened this conversation` : 'Reopened — the customer wrote again';
    case 'order_linked':
      return `${actor} linked order ${s.order_number ?? ''}`.trim();
    case 'order_unlinked':
      return `${actor} unlinked order ${s.order_number ?? ''}`.trim();
    case 'blocked':
      return `${actor} blocked this customer`;
    case 'unblocked':
      return `${actor} unblocked this customer`;
  }
}

/** A reply the shopper saw after it was fetched: `seen` follows the conversation's `customer_seen_at` (QA 8.8e WEB-3). */
export function seenByShopper(m: InboxMessage, customerSeenAt: string | null): InboxMessage {
  if (m.kind !== 'reply' || m.seen || !customerSeenAt) return m;
  return Date.parse(m.created_at) <= Date.parse(customerSeenAt) ? { ...m, seen: true } : m;
}

/** Reply delivery line under a shop bubble (email delivery, SMS notice). */
export function replyStatus(m: Pick<InboxMessage, 'kind' | 'delivery_status' | 'sms_status' | 'seen'>): { text: string; danger: boolean } | null {
  if (m.kind !== 'reply') return null;
  if (m.delivery_status === 'failed') return { text: 'Not delivered', danger: true };
  if (m.seen) return { text: 'Seen', danger: false };
  if (m.sms_status === 'sent') return { text: 'Texted', danger: false };
  if (m.sms_status === 'no_credits') return { text: 'SMS not sent · no credits', danger: false };
  if (m.sms_status === 'failed') return { text: 'SMS failed', danger: false };
  if (m.delivery_status === 'queued') return { text: 'Sending email…', danger: false };
  return null;
}

/** Side-panel buyer-risk box (P88-4 tiers). */
export function riskSummary(r: CustomerRisk | null | undefined): { text: string; tone: 'success' | 'warning' | 'danger' | 'neutral' } | null {
  if (!r) return null;
  const done = `${r.delivered} of ${r.total} delivered with you`;
  switch (r.tier) {
    case 'good':
      return { text: `Good buyer — ${done}.`, tone: 'success' };
    case 'careful':
      return { text: `Be careful — ${done}.`, tone: 'warning' };
    case 'risky':
      return { text: `Risky buyer — ${done}.`, tone: 'danger' };
    default:
      return { text: 'New buyer — no delivered orders with you yet.', tone: 'neutral' };
  }
}

// ----- Messages (§6.2, polling) -----
/** Merge fetched rows into the cached thread: de-duplicated by id, ordered by id (ULIDs sort by time). */
export function mergeMessages(current: readonly InboxMessage[], incoming: readonly InboxMessage[]): InboxMessage[] {
  if (incoming.length === 0) return current as InboxMessage[];
  const byId = new Map<string, InboxMessage>();
  for (const m of current) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The newest shopper message id (what `/read` should move to), or null. */
export function lastCustomerMessageId(messages: readonly InboxMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.kind === 'customer') return messages[i]!.id;
  return null;
}

/** Mark read only forward (the API never moves backwards either). */
export const shouldMarkRead = (lastCustomer: string | null, lastMarked: string | null | undefined) => !!lastCustomer && (!lastMarked || lastCustomer > lastMarked);

export function newClientId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ----- Attachments (§7, P88E-7) -----
export function attachmentProblem(file: { type: string; size: number }, already = 0): string | null {
  if (already >= INBOX_LIMITS.attachments_per_message) return `Up to ${INBOX_LIMITS.attachments_per_message} files per message.`;
  if (!(INBOX_ATTACHMENT_MIMES as readonly string[]).includes(file.type)) return 'Only JPG, PNG or PDF files.';
  if (file.size > INBOX_LIMITS.attachment_max_bytes) return 'Files can be up to 5 MB.';
  return null;
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const attachmentSub = (a: Pick<InboxAttachment, 'mime' | 'size_bytes'>) =>
  `${a.mime === 'application/pdf' ? 'PDF' : a.mime === 'image/png' ? 'PNG' : 'JPG'} · ${fileSize(a.size_bytes)}`;

// ----- Composer: `/` saved replies and merge tags (§8) -----
/** The `/word` being typed at the caret (start of text or after whitespace), else null. */
export function slashQuery(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)\/([a-z0-9_-]*)$/i.exec(before);
  if (!m) return null;
  return { query: m[2]!.toLowerCase(), start: before.length - m[2]!.length - 1 };
}

/** Replace `[start, caret)` (the `/query`) with `insert`; returns the new text and caret. */
export function replaceRange(text: string, start: number, end: number, insert: string): { text: string; caret: number } {
  return { text: text.slice(0, start) + insert + text.slice(end), caret: start + insert.length };
}

/** Saved replies whose title or shortcut matches `q` (prefix on shortcut first). */
export function matchSavedReplies<T extends { title: string; shortcut: string }>(replies: readonly T[], q: string, limit = 6): T[] {
  const s = q.trim().toLowerCase();
  if (!s) return replies.slice(0, limit);
  const starts = replies.filter((r) => r.shortcut.toLowerCase().startsWith(s));
  const rest = replies.filter((r) => !starts.includes(r) && (r.title.toLowerCase().includes(s) || r.shortcut.toLowerCase().includes(s)));
  return [...starts, ...rest].slice(0, limit);
}

const TAG = /\{([a-z_]+)\}/g;

/** Unresolved tags still present in the text (Send stays blocked until they are edited out, §8.2). */
export function remainingTags(text: string, unresolved: readonly string[]): string[] {
  if (unresolved.length === 0) return [];
  return unresolved.filter((t) => text.includes(`{${t}}`));
}

/** `{tags}` in a saved-reply body that are not merge tags (client check before the server's 422). */
export function unknownTags(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(TAG)) if (!(INBOX_MERGE_TAGS as readonly string[]).includes(m[1]!)) out.add(m[1]!);
  return [...out];
}

/** Insert `{tag}` at the selection. */
export function insertTag(body: string, tag: InboxMergeTag, start: number, end: number): { body: string; caret: number } {
  const r = replaceRange(body, start, end, `{${tag}}`);
  return { body: r.text, caret: r.caret };
}

/** Move one item (drag reorder) and return the new id order. */
export function moveId(ids: readonly string[], from: number, to: number): string[] {
  const next = [...ids];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}
