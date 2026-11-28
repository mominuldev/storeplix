import { INBOX_ATTACHMENT_MIMES, INBOX_LIMITS, INBOX_POLL_MS, type InboxAttachmentMime } from '@storeplix/types';

/**
 * PHASE-8-8E §9.3 / §10 shopper Inbox helpers. Pure and client-safe (no Next imports): cookie names, limits,
 * attachment checks, autolinking of shop replies, thread merging and the polling schedule. The tokens themselves
 * (`sp_chat`, `sp_order_access`) are httpOnly cookies only route handlers read; nothing here ever sees them.
 */

/** httpOnly chat session cookie (the API `session_token`), 90 days. */
export const CHAT_COOKIE = 'sp_chat';
/**
 * Non-secret hint (`1`) next to `sp_chat` so the launcher only asks `/api/chat/session` when a session may exist.
 * It carries no token and grants nothing.
 */
export const CHAT_HINT_COOKIE = 'sp_chat_on';
export const CHAT_MAX_AGE = 90 * 24 * 3600;
/** httpOnly `{number}~{access_token}` for order Messages (12 h track · 24 h confirmation · 7 days magic link). */
export const ORDER_ACCESS_COOKIE = 'sp_order_access';
export const ORDER_ACCESS_MAX_AGE = { track: 12 * 3600, confirmation: 24 * 3600, link: 7 * 24 * 3600 } as const;

export const SHOPPER_BODY_MAX = INBOX_LIMITS.shopper_body_max;
export const ATTACHMENT_MAX_BYTES = INBOX_LIMITS.attachment_max_bytes;
export const ATTACHMENT_ACCEPT = 'image/jpeg,image/png,application/pdf,.jpg,.jpeg,.png,.pdf';
export const NAME_MAX = 80;
export const CODE_LENGTH = INBOX_LIMITS.code_length;
export const CODE_RE = new RegExp(`^\\d{${CODE_LENGTH}}$`);
/** ULIDs (messages, attachments). */
export const INBOX_ID_RE = /^[0-9A-Za-z]{26}$/;
export const ORDER_NUMBER_RE = /^[A-Z0-9-]{1,24}$/;
/** Magic-link codes (128-bit random, base62/base64url); a generous range for forward compatibility. */
export const MAGIC_CODE_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const PRODUCT_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** client_id: a UUID made in the browser (idempotent sends). */
export const CLIENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- polling (§12) ----------
export const POLL = {
  widgetOpen: INBOX_POLL_MS.widget_open,
  widgetClosed: INBOX_POLL_MS.widget_closed,
  orderCard: INBOX_POLL_MS.order_card,
  /** Stop after 30 minutes without interaction (resumes on the next one). */
  idleStop: 30 * 60 * 1000,
} as const;

/** Next poll delay in ms, or null = stop (tab hidden or idle for 30 minutes). */
export function nextPollDelay(opts: { interval: number; hidden: boolean; lastInteraction: number; now: number }): number | null {
  if (opts.hidden) return null;
  if (opts.now - opts.lastInteraction >= POLL.idleStop) return null;
  return opts.interval;
}

// ---------- attachments (P88E-7) ----------
export type AttachmentProblem = 'type' | 'size' | 'empty';

const EXT_MIME: Record<string, InboxAttachmentMime> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' };

/** The allowed MIME for a picked file from its declared type, else its extension; null = not JPG/PNG/PDF. */
export function declaredMime(file: { type: string; name: string }): InboxAttachmentMime | null {
  const t = file.type.toLowerCase();
  if ((INBOX_ATTACHMENT_MIMES as readonly string[]).includes(t)) return t as InboxAttachmentMime;
  if (t === 'image/jpg') return 'image/jpeg';
  if (t !== '' && t !== 'application/octet-stream') return null;
  const ext = /\.([a-z0-9]{1,5})$/i.exec(file.name)?.[1]?.toLowerCase();
  return ext ? (EXT_MIME[ext] ?? null) : null;
}

/** Client-side check before upload (the route handler sniffs again and the API sniffs a third time). */
export function attachmentProblem(file: { type: string; name: string; size: number }): AttachmentProblem | null {
  if (file.size <= 0) return 'empty';
  if (!declaredMime(file)) return 'type';
  if (file.size > ATTACHMENT_MAX_BYTES) return 'size';
  return null;
}

/** MIME from the first bytes (JPEG FF D8 FF · PNG signature · `%PDF-`), else null. */
export function sniffMime(bytes: Uint8Array): InboxAttachmentMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return 'image/png';
  if (bytes.length >= 5 && [0x25, 0x50, 0x44, 0x46, 0x2d].every((b, i) => bytes[i] === b)) return 'application/pdf';
  return null;
}

/** `1.2 MB` / `340 KB`. */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(Math.round((bytes / (1024 * 1024)) * 10) / 10).toFixed(1).replace(/\.0$/, '')} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// ---------- text ----------
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Shopper input as sent: control characters (except newlines/tabs) stripped, trimmed, CRLF → LF. */
export function cleanBody(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').replace(CONTROL_EXCEPT_NEWLINE, '').trim();
}

export type TextPart = { kind: 'text'; text: string } | { kind: 'link'; text: string; href: string };

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING = /[.,!?;:)\]}'"]+$/;

function safeHttpUrl(v: string): string | null {
  try {
    const u = new URL(v);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * P88E-23: split a **shop reply** into text and `http(s)` links (rendered with rel="nofollow noopener noreferrer").
 * Shopper text is never passed through here. Anything that does not parse as an http(s) URL stays text.
 */
export function autolink(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    const raw = m[0];
    const trail = TRAILING.exec(raw)?.[0] ?? '';
    const candidate = trail ? raw.slice(0, -trail.length) : raw;
    const href = safeHttpUrl(candidate);
    if (!href) continue;
    if (start > last) parts.push({ kind: 'text', text: text.slice(last, start) });
    parts.push({ kind: 'link', text: candidate, href });
    last = start + candidate.length;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}

// ---------- thread ----------
export interface ThreadAttachment {
  id: string;
  filename: string;
  mime: InboxAttachmentMime;
  size_bytes: number;
  kind: 'image' | 'pdf';
  status: 'processing' | 'ready';
}
/** `InboxShopperMessage` as the browser gets it from our route handlers. */
export interface ThreadMessage {
  id: string;
  from: 'customer' | 'shop';
  body: string | null;
  attachments: ThreadAttachment[];
  author_name: string;
  seen: boolean;
  created_at: string;
}
/** A shopper message on its way (optimistic) or failed (retried with the same client_id). */
export interface PendingMessage {
  client_id: string;
  body: string;
  file: { name: string; size: number } | null;
  state: 'sending' | 'failed';
  error?: string;
  created_at: string;
}

/** Merge polled rows into the thread: dedupe by id (newer copy wins, e.g. `seen`), ordered by id (ULIDs sort by time). */
export function mergeMessages(current: readonly ThreadMessage[], incoming: readonly ThreadMessage[]): ThreadMessage[] {
  if (incoming.length === 0) return current as ThreadMessage[];
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Newest id for `after=` polling. */
export function lastMessageId(messages: readonly ThreadMessage[]): string | null {
  return messages.length ? messages[messages.length - 1]!.id : null;
}

/**
 * `after=` cursor for the next poll. While the shopper's last message is not yet seen by the shop, poll the whole
 * window instead (ETag-guarded, so usually a 304) so its "Seen" marker can update live (QA 8.8e SF/API-2).
 */
export function pollCursor(messages: readonly ThreadMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.from === 'customer') return m.seen ? lastMessageId(messages) : null;
  }
  return lastMessageId(messages);
}

/** Shop rows the shopper has not acknowledged (drives `/seen` and the "new message" announcement). */
export function newestShopId(messages: readonly ThreadMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.from === 'shop') return messages[i]!.id;
  return null;
}

/** Index of the last customer row marked `seen` (the "Seen" marker goes under it only). */
export function lastSeenCustomerIndex(messages: readonly ThreadMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.from === 'customer') return m.seen ? i : -1;
  }
  return -1;
}

/** Cookie-string check for the non-secret session hint (client only). */
export function hasChatHint(cookieString: string): boolean {
  return cookieString.split(';').some((c) => c.trim() === `${CHAT_HINT_COOKIE}=1`);
}

/** `{number}~{token}` → parts, or null. Tokens are opaque base64url/dot strings. */
export function parseOrderAccessCookie(v: string | undefined | null): { number: string; token: string } | null {
  if (!v) return null;
  const m = /^([A-Z0-9-]{1,24})~([A-Za-z0-9._-]{16,512})$/.exec(v);
  return m ? { number: m[1]!, token: m[2]! } : null;
}

export function orderAccessCookieValue(number: string, token: string): string | null {
  const v = `${number.toUpperCase()}~${token}`;
  return parseOrderAccessCookie(v) ? v : null;
}

/** The page the chat started on: path only (no query/fragment), ≤ 300 printable ASCII chars, or null. */
export function cleanPagePath(v: unknown): string | null {
  if (typeof v !== 'string' || !v.startsWith('/') || v.startsWith('//')) return null;
  const path = v.split(/[?#]/)[0]!;
  return path.length <= 300 && /^[\x21-\x7e]+$/.test(path) ? path : null;
}
