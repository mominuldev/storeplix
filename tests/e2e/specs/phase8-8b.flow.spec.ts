import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { merchantOrder, type CommerceShop } from '../support/commerce';
import { listExpenses } from '../support/expenses';
import {
  audit,
  createPo,
  createPoRaw,
  createSupplier,
  deletePoRaw,
  inventoryRow,
  landedUnitCosts,
  lineFor,
  manualOrderQty,
  pay,
  patchPoRaw,
  pdf,
  po,
  poMovements,
  poSummary,
  purchasingShop,
  receive,
  receiveRaw,
  sendPo,
  supplier,
  suppliersSummary,
  today,
  transitionPoRaw,
  variantOf,
  weightedCost,
} from '../support/purchasing';

/**
 * PHASE-8-8B §13 QA main flow, API level (AC 1–4; P88B-2/3/4/5/6/8/10/14/18; S170–S175, S178):
 *  supplier → draft PO with two lines + transport + supplier discount (client totals ignored, store currency) → PO PDF →
 *  "send via PDF" (draft → ordered, incoming shows) → over-receive 422 → receive part with 1 damaged (stock through the
 *  ledger with `purchase_order` references, damaged never stocked, receipt lines keep landed / cost before / after) →
 *  same Idempotency-Key again = one receipt → variant cost = weighted-average landed cost → an earlier order keeps its
 *  snapshot, a new order snapshots the new cost → payment → owed = received value − payments → receive the rest →
 *  received; no expense rows; audit trail. Transitions: close / cancel / delete / revision on a second PO.
 *
 * Numbers (minor units): simple "QA Muslin Wrap" on hand 10 @ 20 000; Kurta M on hand 10 @ 70 000. PO lines: simple
 * 10 × 25 000, M 5 × 60 000 → subtotal 550 000; transport 12 100, discount 1 100 → net 11 000 shared 5 000 / 6 000 →
 * landed 25 500 / 61 200; total 561 000.
 */
test.describe.configure({ mode: 'serial' });

let shop: CommerceShop;
let sup: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let poId = '';
let number = '';
let orderA = '';
const KEY = randomUUID();
const S = { unit: 25_000, qty: 10, cost0: 20_000, onHand0: 10 };
const M = { unit: 60_000, qty: 5, cost0: 70_000, onHand0: 10 };
const SHIPPING = 12_100;
const DISCOUNT = 1_100;
const [LANDED_S, LANDED_M] = landedUnitCosts([{ unit: S.unit, qty: S.qty }, { unit: M.unit, qty: M.qty }], SHIPPING, DISCOUNT);
// first receipt: simple 4 (+1 damaged), M 2
const COST_S1 = weightedCost(S.onHand0, S.cost0, 4, LANDED_S);
const COST_M1 = weightedCost(M.onHand0, M.cost0, 2, LANDED_M);
// second receipt: the rest (simple 5, M 3)
const COST_S2 = weightedCost(S.onHand0 + 4, COST_S1, 5, LANDED_S);
const COST_M2 = weightedCost(M.onHand0 + 2, COST_M1, 3, LANDED_M);
const VALUE_1 = 4 * LANDED_S + 2 * LANDED_M;
const VALUE_2 = VALUE_1 + 5 * LANDED_S + 3 * LANDED_M;
const PAID = 100_000;

const sv = () => shop.simple.variantId;
const mv = () => shop.variable.variants[0].id as string;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  shop = await purchasingShop('pof', 'growth', 10);
  expect(shop.variable.variants[0].option_values ?? ['M']).toContain('M');
});
test.afterAll(() => shop?.cleanup());

test('the landed-cost helper matches the contract example numbers (P88B-6)', () => {
  expect([LANDED_S, LANDED_M]).toEqual([25_500, 61_200]);
  // remainder to the largest line: net 5 000 over 250 000 / 300 000 → 2 272 / 2 727 + 1
  expect(landedUnitCosts([{ unit: 25_000, qty: 10 }, { unit: 60_000, qty: 5 }], 5_000, 0)).toEqual([25_227, 60_546]);
  expect(weightedCost(0, 20_000, 3, 25_500)).toBe(25_500);
  expect(weightedCost(5, null, 3, 25_500)).toBe(25_500);
  expect(weightedCost(-2, 20_000, 3, 25_500)).toBe(25_500);
});

test('supplier + draft PO: PO number, totals recomputed server-side, store currency (P88B-3, S173)', async () => {
  sup = await createSupplier(shop.s, { name: `QA Karim Traders ${randomUUID().slice(0, 4)}`, phone: '01711000123', lead_time_days: 5, payment_terms_days: 15 });
  expect(sup).toMatchObject({ phone: '8801711000123', lead_time_days: 5, owed_amount: 0, open_pos_count: 0, archived_at: null });

  // client totals / currency are ignored (S173)
  const draft = await createPo(
    shop.s,
    sup.id,
    [
      { variant_id: sv(), unit_cost_amount: S.unit, quantity: S.qty },
      { variant_id: mv(), unit_cost_amount: M.unit, quantity: M.qty },
    ],
    { shipping_amount: SHIPPING, discount_amount: DISCOUNT, expected_on: today(), notes: 'QA two lines', subtotal_amount: 1, total_amount: 1, currency: 'USD' },
  );
  poId = draft.id;
  number = draft.number;
  expect(number).toMatch(/^PO-\d+$/);
  expect(draft).toMatchObject({ status: 'draft', currency: 'BDT', subtotal_amount: 550_000, shipping_amount: SHIPPING, discount_amount: DISCOUNT, total_amount: 561_000, received_value_amount: 0, paid_amount: 0, payment_status: 'unpaid' });
  expect(lineFor(draft, sv())).toMatchObject({ unit_cost_amount: S.unit, quantity_ordered: S.qty, quantity_received: 0, quantity_damaged: 0, quantity_left: S.qty, line_total_amount: 250_000, landed_unit_cost_amount: LANDED_S });
  expect(lineFor(draft, mv())).toMatchObject({ unit_cost_amount: M.unit, quantity_ordered: M.qty, landed_unit_cost_amount: LANDED_M });
  // a draft is not incoming stock
  expect((await inventoryRow(shop.s, sv())).incoming).toBe(0);

  // discount > subtotal + shipping → 422; the same variant twice → 422
  const bad = await createPoRaw(shop.s, { supplier_id: sup.id, lines: [{ variant_id: sv(), unit_cost_amount: 100, quantity: 1 }], discount_amount: 200 });
  expect([bad.status, bad.json.error?.code], bad.text.slice(0, 200)).toEqual([422, 'validation_failed']);
  const dup = await createPoRaw(shop.s, { supplier_id: sup.id, lines: [{ variant_id: sv(), unit_cost_amount: 100, quantity: 1 }, { variant_id: sv(), unit_cost_amount: 100, quantity: 2 }] });
  expect(dup.status, dup.text.slice(0, 200)).toBe(422);
});

test('PO PDF, then "Send to supplier" via PDF: draft → ordered, stock shows as incoming (P88B-14)', async () => {
  const doc = await pdf(shop.s, poId);
  expect(doc.status, doc.body.toString('utf8', 0, 300)).toBe(200);
  expect(doc.headers['content-type'] ?? '').toMatch(/application\/pdf|text\/html/);
  // inline, named after the number; the e2e stack's DOCUMENTS_DRIVER=html may serve `.html`
  expect(doc.headers['content-disposition'] ?? '').toMatch(new RegExp(`inline; filename="?${number}\\.(pdf|html)"?`));
  const head = doc.body.toString('latin1', 0, 5);
  if (head !== '%PDF-') {
    const html = doc.body.toString('utf8');
    for (const s of [number, 'QA Muslin Wrap', 'QA Cotton Kurta', sup.name]) expect(html, s).toContain(s);
  }
  test.info().annotations.push({ type: 'pdf', description: head === '%PDF-' ? 'real PDF' : `not a PDF (${doc.headers['content-type']})` });

  const sent = await sendPo(shop.s, poId, 'pdf', (await po(shop.s, poId)).revision);
  expect(sent).toMatchObject({ status: 'ordered', sent_via: 'pdf' });
  expect(sent.sent_at).toBeTruthy();
  expect(sent.ordered_at).toBeTruthy();
  expect((sent.events as Array<{ type: string }>).map((e) => e.type)).toEqual(expect.arrayContaining(['created', 'sent']));
  expect((await inventoryRow(shop.s, sv())).incoming).toBe(S.qty);
  expect((await inventoryRow(shop.s, mv())).incoming).toBe(M.qty);

  const again = await transitionPoRaw(shop.s, poId, 'send', { sent_via: 'pdf' });
  expect([again.status, again.json.error?.code], 'send twice').toEqual([409, 'invalid_state_transition']);
});

test('receive part with 1 damaged: stock via the ledger, weighted-average cost, one receipt per Idempotency-Key (S170–S172)', async () => {
  // an order placed before the receipt snapshots the old cost
  orderA = (await manualOrderQty(shop, sv(), 1)).id as string;
  expect((await merchantOrder(shop.s, orderA)).items[0].unit_cost_amount).toBe(S.cost0);

  const before = await po(shop.s, poId);
  const itemS = lineFor(before, sv()).id as string;
  const itemM = lineFor(before, mv()).id as string;

  // over-receive (received + damaged > left) → 422 over_receive, nothing recorded
  const over = await receiveRaw(shop.s, poId, [{ item_id: itemS, received: 10, damaged: 1 }]);
  expect([over.status, over.json.error?.code], over.text.slice(0, 200)).toEqual([422, 'over_receive']);
  expect(await poMovements(shop.s, poId)).toHaveLength(0);

  const lines = [
    { item_id: itemS, received: 4, damaged: 1 },
    { item_id: itemM, received: 2, damaged: 0 },
  ];
  const after = await receive(shop.s, poId, lines, KEY);
  expect(after).toMatchObject({ status: 'partially_received', received_value_amount: VALUE_1, units_received: 6, units_damaged: 1, units_left: 8 });
  expect(lineFor(after, sv())).toMatchObject({ quantity_received: 4, quantity_damaged: 1, quantity_left: 5 });
  expect(lineFor(after, mv())).toMatchObject({ quantity_received: 2, quantity_damaged: 0, quantity_left: 3 });
  expect(after.receipts).toHaveLength(1);
  const receipt = after.receipts[0];
  expect(receipt).toMatchObject({ units_received: 6, units_damaged: 1, value_amount: VALUE_1 });
  const rl = (variantId: string) => (receipt.lines as Array<Record<string, unknown>>).find((l) => l.variant_id === variantId);
  expect(rl(sv())).toMatchObject({ quantity_received: 4, quantity_damaged: 1, landed_unit_cost_amount: LANDED_S, cost_before_amount: S.cost0, cost_after_amount: COST_S1, on_hand_before: S.onHand0 });
  expect(rl(mv())).toMatchObject({ quantity_received: 2, quantity_damaged: 0, landed_unit_cost_amount: LANDED_M, cost_before_amount: M.cost0, cost_after_amount: COST_M1, on_hand_before: M.onHand0 });

  // stock: received units only, through InventoryService (reason `received`, reference the PO)
  const vs = await variantOf(shop.s, shop.simple.id, sv());
  const vm = await variantOf(shop.s, shop.variable.id, mv());
  expect([vs.inventory.on_hand, vs.cost_amount]).toEqual([S.onHand0 + 4, COST_S1]);
  expect([vm.inventory.on_hand, vm.cost_amount]).toEqual([M.onHand0 + 2, COST_M1]);
  const moves = await poMovements(shop.s, poId);
  expect(moves.map((m) => [m.variant_id, m.reason, m.delta, m.on_hand_after]).sort()).toEqual(
    [
      [sv(), 'received', 4, S.onHand0 + 4],
      [mv(), 'received', 2, M.onHand0 + 2],
    ].sort(),
  );
  for (const m of moves) expect(m.note ?? '', 'movement note "PO-n · supplier"').toContain(number);
  expect((await inventoryRow(shop.s, sv())).incoming).toBe(5);
  expect((await inventoryRow(shop.s, mv())).incoming).toBe(3);

  // the same Idempotency-Key again: same answer, one receipt, one movement per line (S170)
  const replay = await receiveRaw(shop.s, poId, lines, KEY);
  expect([200, 201], replay.text.slice(0, 200)).toContain(replay.status);
  expect(replay.json.data.receipts).toHaveLength(1);
  expect(replay.json.data.receipts[0].id).toBe(receipt.id);
  expect(await poMovements(shop.s, poId)).toHaveLength(2);
  expect((await variantOf(shop.s, shop.simple.id, sv())).inventory.on_hand).toBe(S.onHand0 + 4);
});

test('a new order snapshots the new cost; the earlier order keeps its snapshot (S172, §6.4)', async () => {
  expect((await merchantOrder(shop.s, orderA)).items[0].unit_cost_amount).toBe(S.cost0);
  const b = await manualOrderQty(shop, sv(), 1);
  expect(b.items[0].unit_cost_amount).toBe(COST_S1);
});

test('record a payment: PO paid / payment status, owed = received value − payments (P88B-8, S174)', async () => {
  const p = await pay(shop.s, sup.id, PAID, { purchase_order_id: poId, method: 'bkash', reference: 'TRX-QA-1', note: 'QA part payment' });
  expect(p).toMatchObject({ amount: PAID, currency: 'BDT', method: 'bkash', paid_on: today(), purchase_order: { id: poId, number } });

  const d = await po(shop.s, poId);
  expect(d).toMatchObject({ paid_amount: PAID, payment_status: 'partially_paid', balance_amount: VALUE_1 - PAID });
  expect(d.payments).toHaveLength(1);
  expect((d.events as Array<{ type: string }>).map((e) => e.type)).toEqual(expect.arrayContaining(['received', 'payment_recorded']));

  expect((await supplier(shop.s, sup.id)).owed_amount).toBe(VALUE_1 - PAID);
  expect(await suppliersSummary(shop.s)).toMatchObject({ owed_amount: VALUE_1 - PAID, owed_suppliers_count: 1, pos_on_the_way: 1, bought_this_month_amount: VALUE_1 });
  expect(await poSummary(shop.s)).toMatchObject({ open_count: 1, units_coming: 8, suppliers_coming: 1, owed_amount: VALUE_1 - PAID });
});

test('receive the rest → received; owed follows; further receipts and cancel refused (P88B-2)', async () => {
  const d = await po(shop.s, poId);
  const rest = (d.lines as Array<{ id: string; quantity_left: number }>).map((l) => ({ item_id: l.id, received: l.quantity_left, damaged: 0 }));
  expect(rest.map((l) => l.received).sort()).toEqual([3, 5]);
  const done = await receive(shop.s, poId, rest);
  expect(done).toMatchObject({ status: 'received', received_value_amount: VALUE_2, units_left: 0 });
  expect(done.receipts).toHaveLength(2);

  expect((await variantOf(shop.s, shop.simple.id, sv())).cost_amount).toBe(COST_S2);
  expect((await variantOf(shop.s, shop.variable.id, mv())).cost_amount).toBe(COST_M2);
  expect((await inventoryRow(shop.s, sv())).incoming).toBe(0);
  expect(await poMovements(shop.s, poId)).toHaveLength(4);
  expect((await supplier(shop.s, sup.id)).owed_amount).toBe(VALUE_2 - PAID);

  const more = await receiveRaw(shop.s, poId, [{ item_id: rest[0].item_id, received: 1 }]);
  expect([more.status, more.json.error?.code], more.text.slice(0, 200)).toEqual([409, 'invalid_state_transition']);
  const cancel = await transitionPoRaw(shop.s, poId, 'cancel');
  expect([cancel.status, cancel.json.error?.code]).toEqual([409, 'invalid_state_transition']);
  expect((await deletePoRaw(shop.s, poId)).status, 'only drafts can be deleted').toBe(409);
});

test('second PO: revision check, close keeps received stock and stops incoming; draft cancel + delete (P88B-2)', async () => {
  const p2 = await createPo(shop.s, sup.id, [{ variant_id: mv(), unit_cost_amount: 50_000, quantity: 4 }]);
  const stale = await patchPoRaw(shop.s, p2.id, { shipping_amount: 500, revision: p2.revision - 1 });
  expect([stale.status, stale.json.error?.code]).toEqual([409, 'revision_mismatch']);
  const edited = await patchPoRaw(shop.s, p2.id, { shipping_amount: 500, revision: p2.revision });
  expect(edited.status, edited.text.slice(0, 200)).toBe(200);
  expect(edited.json.data).toMatchObject({ shipping_amount: 500, subtotal_amount: 200_000, total_amount: 200_500 });

  // close from draft is refused; mark ordered → receive 1 → close
  expect((await transitionPoRaw(shop.s, p2.id, 'close')).status).toBe(409);
  const ordered = await transitionPoRaw(shop.s, p2.id, 'mark-ordered', { revision: edited.json.data.revision });
  expect([ordered.status, ordered.json.data?.status, ordered.json.data?.sent_via ?? null]).toEqual([200, 'ordered', null]);
  const onHand = (await variantOf(shop.s, shop.variable.id, mv())).inventory.on_hand as number;
  await receive(shop.s, p2.id, [{ item_id: lineFor(ordered.json.data, mv()).id, received: 1 }]);
  expect((await inventoryRow(shop.s, mv())).incoming).toBe(3);
  const closed = await transitionPoRaw(shop.s, p2.id, 'close');
  expect([closed.status, closed.json.data?.status]).toEqual([200, 'closed']);
  expect((await inventoryRow(shop.s, mv())).incoming, 'closed: remaining stop counting as incoming').toBe(0);
  expect((await variantOf(shop.s, shop.variable.id, mv())).inventory.on_hand).toBe(onHand + 1);
  // cancel after a receipt → 409
  expect((await transitionPoRaw(shop.s, p2.id, 'cancel')).status).toBe(409);

  const p3 = await createPo(shop.s, sup.id, [{ variant_id: sv(), unit_cost_amount: 10_000, quantity: 1 }]);
  const cancelled = await transitionPoRaw(shop.s, p3.id, 'cancel');
  expect([cancelled.status, cancelled.json.data?.status]).toEqual([200, 'cancelled']);
  const p4 = await createPo(shop.s, sup.id, [{ variant_id: sv(), unit_cost_amount: 10_000, quantity: 1 }]);
  expect((await deletePoRaw(shop.s, p4.id)).status).toBe(204);
  expect((await po(shop.s, p2.id)).number).not.toBe(p4.number);
});

test('no purchase reaches expenses; every step audited by the user (S175, S178, P88B-18)', async () => {
  expect(await listExpenses(shop.s, today().slice(0, 7)), 'purchasing never writes expenses').toEqual([]);
  const actions = (await audit(shop.s)).map((a) => a.action as string);
  for (const a of [
    'purchasing.supplier_created',
    'purchasing.purchase_order_created',
    'purchasing.purchase_order_sent',
    'purchasing.receipt_recorded',
    'purchasing.payment_recorded',
    'purchasing.purchase_order_updated',
    'purchasing.purchase_order_marked_ordered',
    'purchasing.purchase_order_closed',
    'purchasing.purchase_order_cancelled',
    'purchasing.purchase_order_deleted',
  ]) {
    expect(actions, a).toContain(a);
  }
  // one receipt audit per recorded receipt (the idempotent replay adds none): PO 1 ×2, PO 2 ×1
  expect(actions.filter((a) => a === 'purchasing.receipt_recorded')).toHaveLength(3);
});
