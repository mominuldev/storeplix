import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageList } from '@/components/inbox/message-list';
import { ChatWidget } from '@/components/inbox/chat-widget';
import ChatPanel, { readChatProduct } from '@/components/inbox/chat-panel';
import { OrderMessages } from '@/components/inbox/order-messages';
import { Composer } from '@/components/inbox/composer';
import { focusables } from '@/components/inbox/use-focus-trap';
import type { ThreadMessage } from '@/lib/inbox-shared';

const msg = (over: Partial<ThreadMessage>): ThreadMessage => ({
  id: '01JD0000000000000000000001', from: 'customer', body: 'hi', attachments: [], author_name: '', seen: false, created_at: '2026-11-28T10:12:00Z', ...over,
});
const config = { shopName: 'Babur Gallery', logoUrl: null, replyTime: 'minutes' as const, hours: '9am–10pm', greeting: null };
const noop = () => {};

describe('MessageList', () => {
  const html = renderToStaticMarkup(
    createElement(MessageList, {
      messages: [
        msg({ id: '01JD0000000000000000000001', body: 'see https://evil.example/x', seen: true }),
        msg({ id: '01JD0000000000000000000002', from: 'shop', author_name: 'Babur Gallery', body: 'Pay: https://shop.example/pay <b>now</b>', attachments: [{ id: '01JD0000000000000000000009', filename: 'invoice.pdf', mime: 'application/pdf', size_bytes: 1258291, kind: 'pdf', status: 'ready' }] }),
        msg({ id: '01JD0000000000000000000003', body: 'thanks', seen: true }),
      ],
      pending: [{ client_id: 'c1', body: 'retry me', file: null, state: 'failed', created_at: '2026-11-28T10:13:00Z' }],
      tone: 'surface',
      lang: 'en',
      attachmentUrl: (id: string) => `/api/chat/attachments/${id}`,
      onRetry: noop,
    }),
  );

  it('is an aria-live log', () => {
    expect(html).toContain('role="log"');
    expect(html).toContain('aria-live="polite"');
  });
  it('autolinks only shop replies, with rel nofollow noopener noreferrer, and escapes markup', () => {
    expect(html).toContain('href="https://shop.example/pay"');
    expect(html).toContain('rel="nofollow noopener noreferrer"');
    expect(html).not.toContain('href="https://evil.example/x"');
    expect(html).toContain('&lt;b&gt;now&lt;/b&gt;');
  });
  it('shows attachments through the proxy, time, Seen on the last customer row, and the retry', () => {
    expect(html).toContain('href="/api/chat/attachments/01JD0000000000000000000009"');
    expect(html).toContain('1.2 MB');
    expect(html).toContain('Sent · 4:12 pm');
    expect(html.match(/data-sp-chat-seen/g)).toHaveLength(1);
    expect(html).toContain('Not sent · Tap to retry');
  });
});

describe('ChatWidget (closed)', () => {
  it('renders only the launcher before it is opened (panel code loads on open)', () => {
    const html = renderToStaticMarkup(createElement(ChatWidget, { config }));
    expect(html).toContain('Chat with us');
    expect(html).toContain('data-sp-chat-launcher');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain('data-sp-chat-panel');
  });
});

describe('ChatPanel steps', () => {
  const ref = { current: null };
  it('guest form: name, mobile, message, attachment, honeypot, privacy line', () => {
    const html = renderToStaticMarkup(createElement(ChatPanel, { config, lang: 'en', session: null, onSession: noop, onClose: noop, returnFocusRef: ref }));
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('Replies in a few minutes · 9am–10pm');
    for (const t of ['Your name', 'Mobile number', 'We text you when we reply', 'Add a photo or PDF', 'up to 5 MB', 'Send message', 'Your number is only used for this chat and order updates.']) expect(html).toContain(t);
    expect(html).toContain('name="website"');
    expect(html).toContain('accept="image/jpeg,image/png,application/pdf');
    expect(html).toContain('data-sp-chat-scrim');
  });
  it('code step after a code was sent', () => {
    const html = renderToStaticMarkup(
      createElement(ChatPanel, { config, lang: 'en', session: { status: 'pending', name: 'Ayesha', phone_masked: '017••••5678', unread_count: 0, resend_after: 60 }, onSession: noop, onClose: noop, returnFocusRef: ref }),
    );
    expect(html).toContain('Enter the 6-digit code we sent to 017••••5678.');
    expect(html).toContain('autoComplete="one-time-code"');
    expect(html).toContain('Resend in 60 s');
    expect(html).toContain('Change number');
  });
  it('thread for an unverified session shows the fallback note and the composer', () => {
    const html = renderToStaticMarkup(
      createElement(ChatPanel, { config, lang: 'en', session: { status: 'unverified', name: 'Ayesha', phone_masked: '017••••5678', unread_count: 0, resend_after: null }, onSession: noop, onClose: noop, returnFocusRef: ref }),
    );
    expect(html).toContain("We couldn&#x27;t text you a code right now.");
    expect(html).toContain('data-sp-chat-composer');
    expect(html).toContain('Write a message…');
  });
  it('Bangla strings are wired', () => {
    const html = renderToStaticMarkup(createElement(ChatPanel, { config, lang: 'bn', session: null, onSession: noop, onClose: noop, returnFocusRef: ref }));
    expect(html).toContain('আপনার নাম');
    expect(html).toContain('মেসেজ পাঠান');
  });
});

describe('readChatProduct', () => {
  it('reads the PDP marker and refuses unsafe values', () => {
    const el = { dataset: { slug: 'merino-cardigan', name: 'Merino cardigan', price: '৳ 1,850', image: 'javascript:alert(1)' } };
    expect(readChatProduct({ querySelector: (() => el) as unknown as Document['querySelector'] })).toEqual({ slug: 'merino-cardigan', name: 'Merino cardigan', price: '৳ 1,850', image: null });
    const bad = { dataset: { slug: '../x', name: 'x' } };
    expect(readChatProduct({ querySelector: (() => bad) as unknown as Document['querySelector'] })).toBeNull();
    expect(readChatProduct({ querySelector: (() => null) as unknown as Document['querySelector'] })).toBeNull();
  });
});

describe('OrderMessages card', () => {
  it('title, reply time, composer and the SMS note (no token anywhere)', () => {
    const html = renderToStaticMarkup(createElement(OrderMessages, { number: 'BG-1001', replyTime: 'hour', via: 'track' }));
    for (const t of ['Messages', 'Replies in about an hour', 'Write a message about this order…', 'Attach photo or PDF', 'Send', 'We also text you when the shop replies. Messages stay with this order.']) expect(html).toContain(t);
    expect(html).toContain('id="messages"');
  });
});

describe('Composer', () => {
  it('chat variant has labelled attach/send controls', () => {
    const html = renderToStaticMarkup(createElement(Composer, { variant: 'chat', lang: 'en', error: 'Too many messages. Wait a minute and try again.', onSend: () => true }));
    expect(html).toContain('aria-label="Attach a photo or PDF"');
    expect(html).toContain('aria-label="Send"');
    expect(html).toContain('role="alert"');
  });
});

describe('focus trap helpers', () => {
  let root: { querySelectorAll: (s: string) => unknown[] };
  beforeEach(() => {
    const el = (attrs: Record<string, string>) => ({ hasAttribute: (k: string) => k in attrs, getAttribute: (k: string) => attrs[k] ?? null });
    root = { querySelectorAll: () => [el({}), el({ inert: '' }), el({ 'aria-hidden': 'true' }), el({})] };
  });
  afterEach(() => vi.restoreAllMocks());
  it('skips inert and aria-hidden elements', () => {
    expect(focusables(root as unknown as ParentNode)).toHaveLength(2);
  });
});
