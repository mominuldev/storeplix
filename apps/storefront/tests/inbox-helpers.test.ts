import { describe, expect, it } from 'vitest';
import {
  attachmentProblem,
  autolink,
  cleanBody,
  cleanPagePath,
  declaredMime,
  formatFileSize,
  hasChatHint,
  lastSeenCustomerIndex,
  pollCursor,
  mergeMessages,
  newestShopId,
  nextPollDelay,
  orderAccessCookieValue,
  parseOrderAccessCookie,
  POLL,
  sniffMime,
  type ThreadMessage,
} from '@/lib/inbox-shared';
import { INBOX_COPY, inboxErrorText } from '@/lib/inbox-copy';
import {
  parseInboxConfig,
  parseMagicLinkResult,
  parseOrderMessagesAccess,
  parseShopperMessages,
  parseWidgetSession,
  parseWidgetStart,
} from '@/lib/inbox-schemas';
import { toShopperTracking } from '@/lib/tracking';
import { parseTracking } from '@/lib/commerce-schemas';

const id = (n: number, from: 'customer' | 'shop' = 'customer', seen = false): ThreadMessage => ({
  id: `01JD${String(n).padStart(22, '0')}`,
  from,
  body: `m${n}`,
  attachments: [],
  author_name: from === 'shop' ? 'Babur Gallery' : '',
  seen,
  created_at: '2026-11-28T10:00:00Z',
});

describe('polling schedule (§12)', () => {
  const now = 1_000_000_000;
  it('polls at the interval while visible and recently used', () => {
    expect(nextPollDelay({ interval: POLL.widgetOpen, hidden: false, lastInteraction: now - 1000, now })).toBe(5000);
    expect(POLL.widgetClosed).toBe(60_000);
    expect(POLL.orderCard).toBe(10_000);
  });
  it('pauses while hidden and stops after 30 minutes without interaction', () => {
    expect(nextPollDelay({ interval: 5000, hidden: true, lastInteraction: now, now })).toBeNull();
    expect(nextPollDelay({ interval: 5000, hidden: false, lastInteraction: now - 30 * 60 * 1000, now })).toBeNull();
    expect(nextPollDelay({ interval: 5000, hidden: false, lastInteraction: now - 29 * 60 * 1000, now })).toBe(5000);
  });
});

describe('attachments (P88E-7)', () => {
  it('accepts JPG/PNG/PDF up to 5 MB only', () => {
    expect(attachmentProblem({ type: 'image/jpeg', name: 'a.jpg', size: 1000 })).toBeNull();
    expect(attachmentProblem({ type: 'application/pdf', name: 'a.pdf', size: 5 * 1024 * 1024 })).toBeNull();
    expect(attachmentProblem({ type: 'image/png', name: 'a.png', size: 5 * 1024 * 1024 + 1 })).toBe('size');
    expect(attachmentProblem({ type: 'image/gif', name: 'a.gif', size: 10 })).toBe('type');
    expect(attachmentProblem({ type: 'text/html', name: 'a.pdf', size: 10 })).toBe('type');
    expect(attachmentProblem({ type: 'image/png', name: 'a.png', size: 0 })).toBe('empty');
  });
  it('falls back to the extension only when the browser gives no type', () => {
    expect(declaredMime({ type: '', name: 'Scan.PDF' })).toBe('application/pdf');
    expect(declaredMime({ type: '', name: 'x.svg' })).toBeNull();
    expect(declaredMime({ type: 'image/jpg', name: 'x' })).toBe('image/jpeg');
  });
  it('sniffs the real type from the first bytes', () => {
    expect(sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffMime(new TextEncoder().encode('%PDF-1.7'))).toBe('application/pdf');
    expect(sniffMime(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeNull();
  });
  it('formats sizes', () => {
    expect(formatFileSize(1.2 * 1024 * 1024)).toBe('1.2 MB');
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5 MB');
    expect(formatFileSize(340 * 1024)).toBe('340 KB');
  });
});

describe('autolink (P88E-23)', () => {
  it('links http(s) URLs and keeps trailing punctuation as text', () => {
    expect(autolink('Pay here: https://shop.example/pay/AB12. Thanks!')).toEqual([
      { kind: 'text', text: 'Pay here: ' },
      { kind: 'link', text: 'https://shop.example/pay/AB12', href: 'https://shop.example/pay/AB12' },
      { kind: 'text', text: '. Thanks!' },
    ]);
  });
  it('never links javascript:, data: or credentialed URLs', () => {
    expect(autolink('javascript:alert(1)').every((p) => p.kind === 'text')).toBe(true);
    expect(autolink('data:text/html,<b>x</b>').every((p) => p.kind === 'text')).toBe(true);
    expect(autolink('https://user:pw@evil.example/').every((p) => p.kind === 'text')).toBe(true);
  });
});

describe('text and paths', () => {
  it('strips control characters but keeps line breaks', () => {
    expect(cleanBody('  Hi\r\nthere\u0007 \u0000 ')).toBe('Hi\nthere');
  });
  it('keeps only the path of the page', () => {
    expect(cleanPagePath('/products/cardigan?utm=x#top')).toBe('/products/cardigan');
    expect(cleanPagePath('//evil.example/x')).toBeNull();
    expect(cleanPagePath('https://x/')).toBeNull();
  });
});

describe('thread merging', () => {
  it('dedupes by id, newer copy wins, sorted by ULID', () => {
    const merged = mergeMessages([id(2), id(1)], [id(3, 'shop'), { ...id(2), seen: true }]);
    expect(merged.map((m) => m.body)).toEqual(['m1', 'm2', 'm3']);
    expect(merged[1]!.seen).toBe(true);
    expect(newestShopId(merged)).toBe(id(3).id);
  });
  it('puts the Seen marker only under the last customer row when it is seen', () => {
    expect(lastSeenCustomerIndex([id(1, 'customer', true), id(2, 'shop'), id(3, 'customer', true)])).toBe(2);
    expect(lastSeenCustomerIndex([id(1, 'customer', true), id(2, 'customer', false)])).toBe(-1);
  });

  it('pollCursor re-polls the whole window while the last customer row is unseen (QA 8.8e SF/API-2)', () => {
    expect(pollCursor([])).toBeNull();
    expect(pollCursor([id(1, 'customer', false), id(2, 'shop')])).toBeNull();
    expect(pollCursor([id(1, 'customer', true), id(2, 'shop')])).toBe(id(2, 'shop').id);
    expect(pollCursor([id(1, 'shop'), id(2, 'shop')])).toBe(id(2, 'shop').id);
  });
});

describe('cookies', () => {
  it('the hint cookie carries no token', () => {
    expect(hasChatHint('a=1; sp_chat_on=1')).toBe(true);
    expect(hasChatHint('sp_chat=abc')).toBe(false);
  });
  it('order access cookie binds the token to the order number', () => {
    const v = orderAccessCookieValue('bg-1001', 'abcDEF123_-.xyz0987654321');
    expect(v).toBe('BG-1001~abcDEF123_-.xyz0987654321');
    expect(parseOrderAccessCookie(v)).toEqual({ number: 'BG-1001', token: 'abcDEF123_-.xyz0987654321' });
    expect(parseOrderAccessCookie('BG-1~short')).toBeNull();
    expect(orderAccessCookieValue('BG 1', 'x'.repeat(20))).toBeNull();
  });
});

describe('boundary schemas', () => {
  it('config: null/absent/all-off → no widget; draft safety is in finalizeConfig', () => {
    expect(parseInboxConfig(undefined)).toBeNull();
    expect(parseInboxConfig({ web_chat: null, order_messages: false })).toBeNull();
    expect(parseInboxConfig({ web_chat: { enabled: true, reply_time: 'hour', hours: '9am–10pm', greeting: null }, order_messages: true })).toEqual({
      web_chat: { enabled: true, reply_time: 'hour', hours: '9am–10pm', greeting: null },
      order_messages: true,
    });
    expect(parseInboxConfig({ web_chat: { enabled: true, reply_time: 'weird', greeting: '\u0000bad' }, order_messages: false })?.web_chat).toEqual({
      enabled: true, reply_time: 'minutes', hours: null, greeting: null,
    });
  });
  it('shopper messages: notes/system rows and bad attachments are dropped', () => {
    const rows = parseShopperMessages([
      { id: '01JD0000000000000000000001', from: 'shop', body: 'Hi <b>there</b>', attachments: [{ id: '01JD0000000000000000000009', filename: 'a.png', mime: 'image/png', size_bytes: 10, kind: 'image', status: 'ready' }, { id: 'bad' }], author_name: 'Shop', seen: false, created_at: '2026-11-28T10:00:00Z' },
      { id: '01JD0000000000000000000002', from: 'note', body: 'internal', attachments: [], author_name: 'x', seen: false, created_at: '2026-11-28T10:00:00Z' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows![0]!.body).toBe('Hi <b>there</b>');
    expect(rows![0]!.attachments).toHaveLength(1);
  });
  it('session, start and link results', () => {
    expect(parseWidgetSession({ status: 'verified', name: 'Ayesha', phone_masked: '017••••5678', unread_count: 2, resend_after: null })?.unread_count).toBe(2);
    expect(parseWidgetStart({ session_token: 't'.repeat(43), status: 'code_sent', phone_masked: '017••••5678', resend_after: 60 })?.status).toBe('code_sent');
    expect(parseWidgetStart({ session_token: '<script>', status: 'code_sent', phone_masked: '017••••5678', resend_after: 60 })).toBeNull();
    expect(parseMagicLinkResult({ kind: 'order', access_token: 'a'.repeat(30), number: 'bg-1001' })).toEqual({ kind: 'order', access_token: 'a'.repeat(30), number: 'BG-1001' });
    expect(parseMagicLinkResult({ kind: 'chat', session_token: 'x' })).toBeNull();
  });
  it('order messages access: the browser view never holds the token', () => {
    const access = parseOrderMessagesAccess({ enabled: true, access_token: 'tok.'.repeat(6), unread_count: 1, reply_time: 'hour' });
    expect(access?.access_token).toBe('tok.'.repeat(6));
    const tracking = parseTracking({
      number: 'BG-1001', status: 'confirmed', placed_at: '2026-11-28T10:00:00Z', shipping: { district: 'Dhaka', thana: 'Dhanmondi' }, lines: [],
      total_amount: 100, due_amount: 100, currency: 'BDT', timeline: [], shipment: null,
      messages: { enabled: true, access_token: 'tok.'.repeat(6), unread_count: 1, reply_time: 'hour' },
    });
    expect(tracking?.messages?.access_token).toBeTruthy();
    const view = toShopperTracking(tracking!);
    expect(view.messages).toEqual({ unread_count: 1, reply_time: 'hour' });
    expect(JSON.stringify(view)).not.toContain('tok.');
  });
});

describe('copy (en + bn)', () => {
  it('every line has English and Bangla', () => {
    const lines = [
      INBOX_COPY.launcher, INBOX_COPY.teaser, INBOX_COPY.send, INBOX_COPY.privacy, INBOX_COPY.unverified, INBOX_COPY.orderNote,
      INBOX_COPY.codeHelp('017••••5678'), INBOX_COPY.thanks('Ayesha', '017••••5678', 'minutes'), INBOX_COPY.resendIn(42),
    ];
    for (const l of lines) {
      expect(l.en.length).toBeGreaterThan(0);
      expect(l.bn).toMatch(/[ঀ-৿]/);
    }
    expect(INBOX_COPY.thanks('Ayesha', '017••••5678', 'minutes').en).toBe("Thanks, Ayesha! We usually reply in a few minutes, and we'll text 017••••5678 when we do.");
    expect(INBOX_COPY.resendIn(42).bn).toContain('৪২');
  });
  it('maps errors to shopper text', () => {
    expect(inboxErrorText({ status: 422, code: 'inbox_code_invalid', details: { attempts_left: 2 } })).toBe("That code isn't right. 2 tries left.");
    expect(inboxErrorText({ status: 429, code: 'rate_limited', details: { retry_after: 30 } })).toBe('Too many tries. Try again in 30 s.');
    expect(inboxErrorText({ status: 0, code: 'network_error' })).toContain('offline');
    expect(inboxErrorText({ status: 404, code: 'order_access_invalid' }, 'bn')).toMatch(/[ঀ-৿]/);
  });
});
