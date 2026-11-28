import { z } from 'zod';
import type {
  InboxMagicLinkResult,
  InboxReplyTime,
  InboxWidgetSession,
  InboxWidgetStart,
  InboxWidgetVerifyResult,
  StorefrontInboxConfig,
  StorefrontOrderMessagesAccess,
} from '@storeplix/types';
import { cleanText } from './text';
import { INBOX_ID_RE, ORDER_NUMBER_RE, type ThreadAttachment, type ThreadMessage } from './inbox-shared';

/**
 * Boundary schemas for the PHASE-8-8E storefront Inbox payloads (openapi 1.25.0). Pure; used by `lib/inbox.ts`
 * (server) and `lib/storefront-api.ts` (config). Tokens are validated for shape here and only ever leave the server
 * as httpOnly cookies.
 */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const replyTime = z.enum(['minutes', 'hour', 'day']);
const ulid = z.string().regex(INBOX_ID_RE);
const isoDate = z.string().max(64).refine((s) => !Number.isNaN(Date.parse(s)));
const masked = z.string().max(24).regex(/^[0-9•*xX+\- ]{4,24}$/);
/** Opaque tokens: base64url, optionally dotted (stateless order tokens). */
const token = z.string().regex(/^[A-Za-z0-9._-]{16,512}$/);
const count = z.number().int().min(0).max(9999).catch(0);

/** Plain text that keeps line breaks (control characters other than \n, \t dropped). */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const bodyText = z
  .unknown()
  .transform((v) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(CONTROL, '').slice(0, 4000) : null))
  .transform((v) => (v && v.trim() ? v : null));

// ---------- config (§9.1) ----------
const InboxConfigSchema = z.object({
  web_chat: z
    .object({
      enabled: z.literal(true),
      reply_time: replyTime.catch('minutes'),
      hours: z.unknown().optional().transform((v) => cleanText(v, 40, 1) ?? null),
      greeting: z.unknown().optional().transform((v) => cleanText(v, 200, 1) ?? null),
    })
    .nullable()
    .catch(null),
  order_messages: z.boolean().catch(false),
});

/** `StorefrontConfig.inbox`; null/absent/malformed → null (no widget, no card). */
export function parseInboxConfig(v: unknown): StorefrontInboxConfig | null {
  if (!isObject(v)) return null;
  const r = InboxConfigSchema.safeParse(v);
  if (!r.success) return null;
  return r.data.web_chat === null && !r.data.order_messages ? null : r.data;
}

// ---------- widget session (§9.2) ----------
const SessionSchema = z.object({
  status: z.enum(['pending', 'verified', 'unverified']),
  name: z.unknown().transform((v) => cleanText(v, 80) ?? ''),
  phone_masked: masked.catch(''),
  unread_count: count,
  resend_after: z.number().int().min(0).max(3600).nullable().catch(null),
}) satisfies z.ZodType<InboxWidgetSession, unknown>;

export function parseWidgetSession(v: unknown): InboxWidgetSession | null {
  const r = SessionSchema.safeParse(v);
  return r.success ? r.data : null;
}

const StartSchema = z.object({
  session_token: token,
  status: z.enum(['code_sent', 'unverified']),
  phone_masked: masked.catch(''),
  resend_after: z.number().int().min(0).max(3600).nullable().catch(null),
}) satisfies z.ZodType<InboxWidgetStart, unknown>;

export function parseWidgetStart(v: unknown): InboxWidgetStart | null {
  const r = StartSchema.safeParse(v);
  return r.success ? r.data : null;
}

const VerifySchema = z.object({ status: z.literal('verified'), unread_count: count }) satisfies z.ZodType<InboxWidgetVerifyResult, unknown>;

export function parseVerifyResult(v: unknown): InboxWidgetVerifyResult | null {
  const r = VerifySchema.safeParse(v);
  return r.success ? r.data : null;
}

// ---------- messages ----------
const AttachmentSchema = z.object({
  id: ulid,
  filename: z.unknown().transform((v) => cleanText(v, 160, 1) ?? 'attachment'),
  mime: z.enum(['image/jpeg', 'image/png', 'application/pdf']),
  size_bytes: z.number().int().min(0).max(5 * 1024 * 1024).catch(0),
  kind: z.enum(['image', 'pdf']),
  status: z.enum(['processing', 'ready']).catch('ready'),
}) satisfies z.ZodType<ThreadAttachment, unknown>;

const MessageSchema = z.object({
  id: ulid,
  from: z.enum(['customer', 'shop']),
  body: bodyText,
  attachments: z
    .array(z.unknown())
    .max(3)
    .catch([])
    .transform((xs) => xs.flatMap((x) => {
      const r = AttachmentSchema.safeParse(x);
      return r.success ? [r.data] : [];
    })),
  author_name: z.unknown().transform((v) => cleanText(v, 200) ?? ''),
  seen: z.boolean().catch(false),
  created_at: isoDate,
}) satisfies z.ZodType<ThreadMessage, unknown>;

/** One shopper-visible row (customer or shop); anything else (notes, system rows) is not a valid row. */
export function parseShopperMessage(v: unknown): ThreadMessage | null {
  const r = MessageSchema.safeParse(v);
  return r.success ? r.data : null;
}

/** A list of rows: invalid rows are dropped (≤ 100 per poll). */
export function parseShopperMessages(v: unknown): ThreadMessage[] | null {
  if (!Array.isArray(v)) return null;
  return v.slice(0, 100).flatMap((x) => {
    const m = parseShopperMessage(x);
    return m ? [m] : [];
  });
}

// ---------- order messages (§10) ----------
const OrderAccessSchema = z.object({
  enabled: z.literal(true),
  access_token: token,
  unread_count: count,
  reply_time: replyTime.catch('hour'),
}) satisfies z.ZodType<StorefrontOrderMessagesAccess, unknown>;

/** `StorefrontOrderTracking.messages`: null when off, absent or malformed. Server-side only (holds the token). */
export function parseOrderMessagesAccess(v: unknown): StorefrontOrderMessagesAccess | null {
  if (!isObject(v)) return null;
  const r = OrderAccessSchema.safeParse(v);
  return r.success ? r.data : null;
}

/** What the browser may know about order Messages (never the token). */
export interface ShopperOrderMessages {
  unread_count: number;
  reply_time: InboxReplyTime;
}

export function shopperOrderMessages(access: StorefrontOrderMessagesAccess | null | undefined): ShopperOrderMessages | null {
  return access ? { unread_count: access.unread_count, reply_time: access.reply_time } : null;
}

// ---------- magic link ----------
const LinkSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chat'), session_token: token }),
  z.object({ kind: z.literal('order'), access_token: token, number: z.string().transform((s) => s.toUpperCase()).pipe(z.string().regex(ORDER_NUMBER_RE)) }),
]) satisfies z.ZodType<InboxMagicLinkResult, unknown>;

export function parseMagicLinkResult(v: unknown): InboxMagicLinkResult | null {
  const r = LinkSchema.safeParse(v);
  return r.success ? r.data : null;
}
