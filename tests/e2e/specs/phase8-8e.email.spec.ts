import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signInDashboard } from '../support/api';
import { placeOrder, randomPhone, type CommerceShop } from '../support/commerce';
import {
  allConversations,
  cleanupInboxShop,
  conversation,
  findConversation,
  header,
  inboundEmailRaw,
  inboxShop,
  INBOUND_FAKE_KEY,
  mailMark,
  messages,
  openThread,
  pdf,
  reply,
  sendFromComposer,
  setChannels,
  storeAddress,
  thread,
  waitMail,
} from '../support/inbox';

/**
 * PHASE-8-8E §11 (P88E-15, P88E-16, S243), AC 2 + AC 4 (email replies) with `INBOUND_MAIL_DRIVER=fake` (Mailgun field
 * format + HMAC-SHA256(timestamp . token) signed with INBOUND_MAIL_FAKE_KEY) and `MAIL_MAILER=log`:
 *  - a signed inbound mail to the store address → `email` conversation (subject, identity `email` on SPF pass);
 *  - bad signature / stale timestamp / replayed token → 401 `inbound_email_signature_invalid`, nothing stored; unknown
 *    address → 202 `{accepted: false}`; auto-replies dropped; the same Message-ID twice → one message;
 *  - a reply from the dashboard goes out by email: To the shopper, Reply-To `c-{conversation}-{sig}@domain`, subject
 *    `Re: …`, In-Reply-To the inbound Message-ID; the shopper's answer to that address lands in the same conversation;
 *    another sender writing to it does not;
 *  - the shopper order email carries Reply-To `o-{order}-{sig}@domain` when the channel is on, and a reply to it opens an
 *    email conversation with the order linked; channel off → order email Reply-To back to the store contact.
 */
test.describe.configure({ mode: 'serial' });

let shop: CommerceShop;
let address: string;
const SHOPPER = 'rumana.qa@mail.e2e.storeplix.test';
const accepted = (r: { json: Record<string, any> }) => r.json.data?.accepted ?? r.json.accepted; // eslint-disable-line @typescript-eslint/no-explicit-any

test.beforeAll(async () => {
  test.setTimeout(180_000);
  shop = await inboxShop('ibxem', { email: true });
  address = await storeAddress(shop.s);
});
test.afterAll(() => cleanupInboxShop(shop));

test('signature, timestamp, replay, unknown address, loop protection, dedupe', async () => {
  const ts = Math.floor(Date.now() / 1000);
  const badSig = await inboundEmailRaw({ to: address, from: SHOPPER, text: 'SIG-QA', signature: 'f'.repeat(64) });
  expect([badSig.status, badSig.json.error?.code]).toEqual([401, 'inbound_email_signature_invalid']);
  const wrongKey = await inboundEmailRaw({ to: address, from: SHOPPER, text: 'SIG-QA', key: `${INBOUND_FAKE_KEY}-nope` });
  expect(wrongKey.status).toBe(401);
  const stale = await inboundEmailRaw({ to: address, from: SHOPPER, text: 'SIG-QA', timestamp: ts - 16 * 60 });
  expect([stale.status, stale.json.error?.code]).toEqual([401, 'inbound_email_signature_invalid']);
  const token = randomUUID().replace(/-/g, '');
  const first = await inboundEmailRaw({ to: address, from: SHOPPER, subject: 'Replay QA', text: 'REPLAY-QA once', token });
  expect(first.status, first.text.slice(0, 300)).toBe(202);
  const replay = await inboundEmailRaw({ to: address, from: SHOPPER, subject: 'Replay QA', text: 'REPLAY-QA twice', token });
  expect([replay.status, replay.json.error?.code]).toEqual([401, 'inbound_email_signature_invalid']);

  const unknown = await inboundEmailRaw({ to: `shop-aaaaaaaaaaaa@${address.split('@')[1]}`, from: SHOPPER, text: 'UNKNOWN-QA' });
  expect([unknown.status, accepted(unknown)]).toEqual([202, false]);
  const auto = await inboundEmailRaw({ to: address, from: SHOPPER, text: 'AUTO-QA out of office', headers: [['Auto-Submitted', 'auto-replied']] });
  expect(auto.status).toBe(202);
  const bulk = await inboundEmailRaw({ to: address, from: 'news@mail.e2e.storeplix.test', text: 'BULK-QA newsletter', headers: [['Precedence', 'bulk']] });
  expect(bulk.status).toBe(202);
  const daemon = await inboundEmailRaw({ to: address, from: 'mailer-daemon@mail.e2e.storeplix.test', text: 'DAEMON-QA bounce' });
  expect(daemon.status).toBe(202);

  const mid = `<${randomUUID()}@mail.e2e.storeplix.test>`;
  for (let i = 0; i < 2; i++) expect((await inboundEmailRaw({ to: address, from: SHOPPER, subject: 'Dup QA', text: 'DUP-QA same message', messageId: mid })).status).toBe(202);

  const conv = await findConversation(shop.s, (x) => x.channel === 'email' && x.contact?.email === SHOPPER, 'email conversation');
  await expect
    .poll(async () => (await messages(shop.s, conv.id)).filter((m) => String(m.body).includes('DUP-QA')).length, { timeout: 30_000 })
    .toBe(1);
  const all = JSON.stringify(await allConversations(shop.s)) + JSON.stringify(await messages(shop.s, conv.id));
  for (const n of ['SIG-QA', 'REPLAY-QA twice', 'UNKNOWN-QA', 'AUTO-QA', 'BULK-QA', 'DAEMON-QA']) expect(all, n).not.toContain(n);
  expect(all).toContain('REPLAY-QA once');
  expect(conv.identity).toBe('email');
});

test('inbound → dashboard reply by email (Reply-To, Re:, In-Reply-To) → shopper answer threads; other senders do not', async ({ page, context }) => {
  test.setTimeout(150_000);
  const from = `nadia.${Date.now().toString(36)}@mail.e2e.storeplix.test`;
  const mid = `<${randomUUID()}@mail.e2e.storeplix.test>`;
  const r = await inboundEmailRaw({
    to: address,
    from,
    fromName: 'Nadia Islam',
    subject: 'Wrong size received',
    text: 'I got M instead of L.\n\nOn Mon, Shop wrote:\n> Your order is on the way\n> Thanks',
    messageId: mid,
    attachments: [pdf('receipt.pdf')],
  });
  expect(r.status, r.text.slice(0, 300)).toBe(202);
  const conv = await findConversation(shop.s, (x) => x.channel === 'email' && x.contact?.email === from, 'email from Nadia');
  const detail = await conversation(shop.s, conv.id);
  expect(detail.subject).toBe('Wrong size received');
  const first = (await messages(shop.s, conv.id)).find((m) => m.kind === 'customer')!;
  expect(first.body).toBe('I got M instead of L.'); // quoted history trimmed
  expect(first.attachments.map((a: { mime: string }) => a.mime)).toEqual(['application/pdf']);

  const mark = mailMark();
  await signInDashboard(context, shop.s);
  await openThread(page, conv.id);
  await expect(page.getByText('Sends by email')).toBeVisible();
  await sendFromComposer(page, 'Sorry! We will swap it for L tomorrow. https://example.com/swap');
  const mail = await waitMail(mark, from, (e) => /Subject: Re: Wrong size received/.test(e), 'reply mail to the shopper');
  const replyTo = header(mail, 'Reply-To') ?? '';
  expect(replyTo).toMatch(new RegExp(`c-${conv.id.toLowerCase()}-[0-9a-f]{12}@${address.split('@')[1].replace(/\./g, '\\.')}`));
  expect(header(mail, 'In-Reply-To')).toBe(mid);
  expect(header(mail, 'References') ?? '').toContain(mid);
  expect(header(mail, 'From') ?? '').toMatch(/QA ibxem shop/);
  await expect.poll(async () => (await messages(shop.s, conv.id)).filter((m) => m.kind === 'reply').at(-1)?.delivery_status, { timeout: 60_000 }).toBe('sent');
  await expect(thread(page)).not.toContainText('Not delivered');

  const convAddress = replyTo.match(/c-[^>\s]+/)![0];
  const answer = await inboundEmailRaw({ to: convAddress, from, subject: 'Re: Wrong size received', text: 'Great, thank you!', inReplyTo: `<x-${randomUUID()}@storeplix>` });
  expect([answer.status, accepted(answer)]).toEqual([202, true]);
  await expect.poll(async () => (await messages(shop.s, conv.id)).some((m) => m.kind === 'customer' && m.body === 'Great, thank you!'), { timeout: 30_000 }).toBe(true);
  await expect(thread(page)).toContainText('Great, thank you!', { timeout: 20_000 });

  // A different sender to the conversation address is treated as the store address (own thread), never appended.
  const intruder = `intruder.${Date.now().toString(36)}@mail.e2e.storeplix.test`;
  expect((await inboundEmailRaw({ to: convAddress, from: intruder, text: 'INTRUDER-QA hi' })).status).toBe(202);
  await findConversation(shop.s, (x) => x.contact?.email === intruder, 'intruder thread');
  expect((await messages(shop.s, conv.id)).some((m) => String(m.body).includes('INTRUDER-QA'))).toBe(false);
  // A guessed conversation address without the signature is ignored.
  const forged = await inboundEmailRaw({ to: `c-${conv.id.toLowerCase()}-000000000000@${address.split('@')[1]}`, from, text: 'FORGED-QA' });
  expect(forged.status).toBe(202);
  expect((await messages(shop.s, conv.id)).some((m) => String(m.body).includes('FORGED-QA'))).toBe(false);
});

test('order email Reply-To = signed order address when on; a reply to it links the order; off → store contact', async () => {
  test.setTimeout(150_000);
  const email = `buyer.${Date.now().toString(36)}@mail.e2e.storeplix.test`;
  const mark = mailMark();
  const placed = await placeOrder(shop, shop.simple.variantId, 1, { body: { contact: { name: 'Sadia Rahman', phone: randomPhone(), email } } });
  const mail = await waitMail(mark, email, (e) => e.includes(placed.order.number as string), 'order placed email');
  const replyTo = header(mail, 'Reply-To') ?? '';
  expect(replyTo).toMatch(/o-[0-9a-z]{26}-[0-9a-f]{12}@/);
  const orderAddress = replyTo.match(/o-[^>\s]+/)![0];
  const r = await inboundEmailRaw({ to: orderAddress, from: email, subject: `Re: Order ${placed.order.number}`, text: 'Can I change the address?' });
  expect([r.status, accepted(r)]).toEqual([202, true]);
  const conv = await findConversation(shop.s, (x) => x.channel === 'email' && x.contact?.email === email, 'order email conversation');
  expect(conv.order?.number).toBe(placed.order.number);
  expect((await messages(shop.s, conv.id)).some((m) => m.kind === 'system' && m.system?.event === 'order_linked')).toBe(true);

  // A dashboard reply in this thread also goes out by email.
  const m2 = mailMark();
  await reply(shop.s, conv.id, 'Yes, send me the new address.');
  await waitMail(m2, email, (e) => /Subject: Re: /.test(e), 'reply to the order email thread');

  await setChannels(shop.s, { email: false });
  try {
    const off = mailMark();
    const email2 = `buyer2.${Date.now().toString(36)}@mail.e2e.storeplix.test`;
    const p2 = await placeOrder(shop, shop.simple.variantId, 1, { body: { contact: { name: 'Sadia Rahman', phone: randomPhone(), email: email2 } } });
    const m = await waitMail(off, email2, (e) => e.includes(p2.order.number as string), 'order email with the channel off');
    expect(header(m, 'Reply-To') ?? '').not.toMatch(/o-[0-9a-z]{26}-/);
    // Channel off: inbound to the store address is dropped (202, nothing new).
    const dropped = await inboundEmailRaw({ to: address, from: email2, text: 'OFF-QA anyone?' });
    expect(dropped.status).toBe(202);
    await new Promise((res) => setTimeout(res, 3_000));
    expect(JSON.stringify(await allConversations(shop.s))).not.toContain('OFF-QA');
  } finally {
    await setChannels(shop.s, { email: true });
  }
});
