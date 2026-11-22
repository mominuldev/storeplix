import 'server-only';

/**
 * DEV ONLY: openapi-shaped in-memory stand-in for the Phase 5a storefront endpoints, used while the
 * API lands (`STOREFRONT_COMMERCE_MOCK=1`, never in production). Shapes follow docs/api/openapi.yaml
 * v1.5.0; the logic is deliberately simple (one zone rule, two coupons).
 */
export function commerceMockEnabled(): boolean {
  return process.env.STOREFRONT_COMMERCE_MOCK === '1' && process.env.NODE_ENV !== 'production';
}

const IMG = (file: string, n: number) => ({
  id: `01jm0ck0000000000000000${String(n).padStart(3, '0')}`,
  url: `/themes/modern-commerce/images/${file}`,
  width: 800,
  height: 1000,
  alt: null,
  srcset: [],
});

interface MockVariant {
  id: string;
  title: string;
  option_values: string[];
  price_amount: number;
  compare_at_amount: number | null;
  image: number | null;
  stock: number | null; // null = untracked
}
interface MockProduct {
  id: string;
  slug: string;
  name: string;
  category: string;
  options: Array<{ name: string; values: string[] }>;
  variants: MockVariant[];
  images: Array<ReturnType<typeof IMG>>;
}

const v = (id: string, ov: string[], price: number, compare: number | null, stock: number | null, image: number | null = null): MockVariant => ({
  id: `01jmockvar00000000000000${id}`,
  title: ov.join(' / '),
  option_values: ov,
  price_amount: price,
  compare_at_amount: compare,
  image,
  stock,
});

const PRODUCTS: MockProduct[] = [
  {
    id: '01jmockprod0000000000000p1',
    slug: 'merino-cable-knit-cardigan',
    name: 'Merino cable-knit cardigan',
    category: 'cardigans',
    options: [
      { name: 'Colour', values: ['Honey', 'Sky'] },
      { name: 'Size', values: ['1–2 y', '2–3 y', '3–4 y'] },
    ],
    variants: [
      v('01', ['Honey', '1–2 y'], 185000, 230000, 12, 0),
      v('02', ['Honey', '2–3 y'], 185000, 230000, 4, 0),
      v('03', ['Honey', '3–4 y'], 195000, 230000, 0, 0),
      v('04', ['Sky', '2–3 y'], 185000, null, 20, 1),
    ],
    images: [IMG('cardigan.png', 1), IMG('puffer.png', 2), IMG('hero-main.png', 3)],
  },
  { id: '01jmockprod0000000000000p2', slug: 'fair-isle-beanie-mittens', name: 'Fair-isle beanie & mittens', category: 'cardigans', options: [], variants: [v('05', [], 89000, null, null)], images: [IMG('gift-set.png', 4)] },
  { id: '01jmockprod0000000000000p3', slug: 'sherpa-lined-booties', name: 'Sherpa-lined winter booties', category: 'cardigans', options: [], variants: [v('06', [], 119000, 139000, 3)], images: [IMG('stacker.png', 5)] },
  { id: '01jmockprod0000000000000p4', slug: 'fleece-lined-puffer', name: 'Fleece-lined quilted puffer', category: 'winter-wear', options: [], variants: [v('07', [], 345000, null, 30)], images: [IMG('puffer.png', 6)] },
];

const GEO = {
  version: 'mock-1',
  divisions: [
    { code: 'dhaka', name: 'Dhaka', name_bn: 'ঢাকা' },
    { code: 'chattogram', name: 'Chattogram', name_bn: 'চট্টগ্রাম' },
  ],
  districts: [
    { code: 'dhaka', division_code: 'dhaka', name: 'Dhaka', name_bn: 'ঢাকা' },
    { code: 'gazipur', division_code: 'dhaka', name: 'Gazipur', name_bn: 'গাজীপুর' },
    { code: 'chattogram', division_code: 'chattogram', name: 'Chattogram', name_bn: 'চট্টগ্রাম' },
  ],
  thanas: [
    { code: 'dhaka-dhanmondi', district_code: 'dhaka', name: 'Dhanmondi', name_bn: 'ধানমন্ডি', is_city: true },
    { code: 'dhaka-mirpur', district_code: 'dhaka', name: 'Mirpur', name_bn: 'মিরপুর', is_city: true },
    { code: 'dhaka-savar', district_code: 'dhaka', name: 'Savar', name_bn: 'সাভার', is_city: false },
    { code: 'gazipur-tongi', district_code: 'gazipur', name: 'Tongi', name_bn: 'টঙ্গী', is_city: false },
    { code: 'chattogram-kotwali', district_code: 'chattogram', name: 'Kotwali', name_bn: 'কোতোয়ালী', is_city: true },
  ],
};

interface CartState {
  lines: Array<{ id: string; variant_id: string; quantity: number }>;
  coupon: string | null;
}
interface OrderState {
  number: string;
  phone: string;
  token: string;
  order: Record<string, unknown>;
  status: string;
}
interface MockDb {
  carts: Map<string, CartState>;
  idem: Map<string, { hash: string; body: unknown }>;
  orders: OrderState[];
  seq: number;
}
const g = globalThis as unknown as { __spMock?: MockDb };
const db: MockDb = (g.__spMock ??= { carts: new Map(), idem: new Map(), orders: [], seq: 1000 });

const FREE_OVER = 300000;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store', ...headers } });
const err = (status: number, code: string, message: string, details?: Record<string, string[]>) => json(status, { error: { code, message, ...(details ? { details } : {}) } });
const rand = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');

const findVariant = (id: string) => {
  for (const p of PRODUCTS) for (const x of p.variants) if (x.id === id) return { p, v: x };
  return null;
};
const available = (x: MockVariant) => (x.stock === null ? Infinity : x.stock);
const lowStock = (x: MockVariant) => (x.stock !== null && x.stock > 0 && x.stock <= 5 ? x.stock : null);

const card = (p: MockProduct) => {
  const cheapest = [...p.variants].sort((a, b) => a.price_amount - b.price_amount)[0]!;
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    subtitle: p.category === 'cardigans' ? 'Cardigans & sweaters' : 'Winter wear',
    price_amount: cheapest.price_amount,
    compare_at_amount: cheapest.compare_at_amount,
    currency: 'BDT',
    on_sale: cheapest.compare_at_amount !== null,
    image: p.images[0] ?? null,
  };
};

function price(cart: CartState) {
  const lines = cart.lines.map((l) => {
    const f = findVariant(l.variant_id)!;
    const avail = available(f.v);
    const issue = avail < l.quantity ? 'insufficient_stock' : null;
    return {
      id: l.id,
      variant_id: l.variant_id,
      product_slug: f.p.slug,
      product_name: f.p.name,
      variant_title: f.v.title,
      option_values: f.v.option_values,
      image: f.v.image !== null ? (f.p.images[f.v.image] ?? null) : (f.p.images[0] ?? null),
      quantity: l.quantity,
      unit_price_amount: f.v.price_amount,
      compare_at_amount: f.v.compare_at_amount,
      line_amount: f.v.price_amount * l.quantity,
      issue,
      max_quantity: issue ? Math.max(0, avail) : null,
      low_stock: lowStock(f.v),
    };
  });
  const ok = lines.filter((l) => !l.issue);
  const subtotal = ok.reduce((s, l) => s + l.line_amount, 0);
  const compareSavings = ok.reduce((s, l) => s + (l.compare_at_amount ? (l.compare_at_amount - l.unit_price_amount) * l.quantity : 0), 0);
  let discount = 0;
  let coupon = null as null | { code: string; type: 'percentage' | 'free_shipping'; discount_amount: number; free_shipping: boolean };
  if (cart.coupon === 'WINTER15') {
    discount = Math.min(Math.floor((subtotal * 1500) / 10000), 50000);
    coupon = { code: 'WINTER15', type: 'percentage', discount_amount: discount, free_shipping: false };
  } else if (cart.coupon === 'FREESHIP') {
    coupon = { code: 'FREESHIP', type: 'free_shipping', discount_amount: 0, free_shipping: true };
  }
  const est = subtotal - discount;
  return {
    lines,
    lines_count: lines.length,
    items_count: lines.reduce((s, l) => s + l.quantity, 0),
    currency: 'BDT',
    coupon,
    subtotal_amount: subtotal,
    discount_amount: discount,
    savings_amount: compareSavings + discount,
    estimated_total_amount: est,
    free_delivery: { threshold_amount: FREE_OVER, remaining_amount: Math.max(0, FREE_OVER - est) },
    can_checkout: ok.length > 0 && ok.length === lines.length,
  };
}

function quote(cart: CartState, district: string, thana: string) {
  const t = GEO.thanas.find((x) => x.code === thana && x.district_code === district);
  if (!t) return null;
  const inside = t.is_city && district === 'dhaka';
  const zone = inside ? { zone_id: 'z1', zone_name: 'Inside Dhaka', min_days: 1, max_days: 2, charge_amount: 7000 } : { zone_id: 'z2', zone_name: 'Outside Dhaka', min_days: 2, max_days: 4, charge_amount: 13000 };
  const priced = price(cart);
  const free = priced.estimated_total_amount >= FREE_OVER || priced.coupon?.free_shipping === true;
  return { ...zone, amount: free ? 0 : zone.charge_amount, is_free: free };
}

export async function commerceMockFetch(url: string, init: RequestInit): Promise<Response> {
  const u = new URL(url);
  const path = u.pathname.replace(/^\/api\/v1/, '');
  const method = init.method ?? 'GET';
  const h = new Headers(init.headers);
  const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  const token = h.get('X-Cart-Token');
  const cart = token ? db.carts.get(token) : undefined;
  const q = u.searchParams;

  if (path === '/geo/bd') return json(200, { data: GEO });

  if (path === '/storefront/products' && method === 'GET') {
    let list = PRODUCTS.filter((p) => !q.get('category') || p.category === q.get('category') || (q.get('category') === 'winter-wear' && p.category === 'cardigans'));
    if (q.get('q')) list = list.filter((p) => p.name.toLowerCase().includes(q.get('q')!.toLowerCase()));
    if (q.get('exclude')) list = list.filter((p) => p.id !== q.get('exclude'));
    let cards = list.map((p) => ({ p, c: card(p) }));
    if (q.get('price_min')) cards = cards.filter((x) => x.c.price_amount >= Number(q.get('price_min')));
    if (q.get('price_max')) cards = cards.filter((x) => x.c.price_amount <= Number(q.get('price_max')));
    if (q.get('in_stock') === '1') cards = cards.filter((x) => x.p.variants.some((y) => available(y) > 0));
    if (q.get('sort') === 'price_asc') cards.sort((a, b) => a.c.price_amount - b.c.price_amount);
    if (q.get('sort') === 'price_desc') cards.sort((a, b) => b.c.price_amount - a.c.price_amount);
    const out = cards.map((x) => x.c);
    if (q.get('page')) {
      const page = Number(q.get('page'));
      const per = Number(q.get('per_page') ?? 24);
      return json(200, { data: out.slice((page - 1) * per, page * per), meta: { has_products: true, current_page: page, per_page: per, total: out.length, last_page: Math.max(1, Math.ceil(out.length / per)) } });
    }
    return json(200, { data: out.slice(0, Number(q.get('limit') ?? 24)), meta: { has_products: true } });
  }

  let m = /^\/storefront\/products\/([a-z0-9-]+)(\/availability)?$/.exec(path);
  if (m) {
    const p = PRODUCTS.find((x) => x.slug === m![1]);
    if (!p) return err(404, 'not_found', 'Not found.');
    if (m[2]) return json(200, { data: { variants: p.variants.map((x) => ({ id: x.id, available: available(x) > 0, low_stock: lowStock(x) })) } });
    return json(200, {
      data: {
        id: p.id,
        slug: p.slug,
        name: p.name,
        description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `Soft, warm and made for Dhaka winters. The ${p.name.toLowerCase()} washes well and lasts.` }] }] },
        options: p.options,
        variants: p.variants.map((x) => ({ id: x.id, title: x.title, option_values: x.option_values, price_amount: x.price_amount, compare_at_amount: x.compare_at_amount, image_media_id: x.image !== null ? p.images[x.image]!.id : null })),
        images: p.images.map((i) => ({ media_id: i.id, alt: null, media: i })),
        price_min_amount: Math.min(...p.variants.map((x) => x.price_amount)),
        price_max_amount: Math.max(...p.variants.map((x) => x.price_amount)),
        currency: 'BDT',
        categories: [{ slug: 'winter-wear', name: 'Winter wear' }],
        seo: { title: null, description: null },
        url_path: `/products/${p.slug}`,
        is_preview_only: false,
        updated_at: '2026-11-20T10:00:00Z',
      },
    });
  }

  if (path === '/storefront/categories') return json(200, { data: [{ slug: 'winter-wear', name: 'Winter wear', image: null, url_path: '/c/winter-wear', children: [{ slug: 'cardigans', name: 'Cardigans & sweaters', image: null, url_path: '/c/cardigans', children: [] }] }] });
  m = /^\/storefront\/categories\/([a-z0-9-]+)$/.exec(path);
  if (m) {
    if (m[1] === 'winter-wear')
      return json(200, { data: { slug: 'winter-wear', name: 'Winter wear', image: IMG('editorial-winter.png', 9), url_path: '/c/winter-wear', description: 'Merino, quilted cotton and soft fleece for Dhaka mornings.', ancestors: [], children: [{ slug: 'cardigans', name: 'Cardigans & sweaters', url_path: '/c/cardigans' }] } });
    if (m[1] === 'cardigans') return json(200, { data: { slug: 'cardigans', name: 'Cardigans & sweaters', image: null, url_path: '/c/cardigans', description: null, ancestors: [{ slug: 'winter-wear', name: 'Winter wear' }], children: [] } });
    return err(404, 'not_found', 'Not found.');
  }

  if (path === '/storefront/cart' && method === 'GET') return cart ? json(200, { data: price(cart), meta: {} }) : err(404, 'cart_not_found', 'Cart not found.');

  if (path === '/storefront/cart/items' && method === 'POST') {
    const f = findVariant(String(body.variant_id));
    if (!f) return err(422, 'validation_failed', 'Invalid.', { variant_id: ["This item isn't available."] });
    const qty = Number(body.quantity);
    let c = cart;
    let created: string | null = null;
    if (!c) {
      created = rand();
      c = { lines: [], coupon: null };
      db.carts.set(created, c);
    }
    const line = c.lines.find((l) => l.variant_id === f.v.id);
    const want = Math.min(99, (line?.quantity ?? 0) + qty);
    if (available(f.v) < want) return err(422, 'out_of_stock', 'Out of stock.', { quantity: [available(f.v) > 0 ? `Only ${available(f.v)} left.` : 'Sold out.'] });
    if (line) line.quantity = want;
    else c.lines.push({ id: `01jmockline${rand().replace(/[^a-z0-9]/gi, '').slice(0, 15).toLowerCase()}`, variant_id: f.v.id, quantity: want });
    return json(created ? 201 : 200, { data: price(c), meta: created ? { cart_token: created } : {} });
  }

  m = /^\/storefront\/cart\/items\/([A-Za-z0-9_-]+)$/.exec(path);
  if (m) {
    if (!cart) return err(404, 'cart_not_found', 'Cart not found.');
    const line = cart.lines.find((l) => l.id === m![1]);
    if (!line) return err(404, 'not_found', 'Not found.');
    if (method === 'DELETE') cart.lines = cart.lines.filter((l) => l !== line);
    else {
      const f = findVariant(line.variant_id)!;
      if (available(f.v) < Number(body.quantity)) return err(422, 'out_of_stock', 'Out of stock.', { quantity: [`Only ${available(f.v)} left.`] });
      line.quantity = Number(body.quantity);
    }
    return json(200, { data: price(cart), meta: {} });
  }

  if (path === '/storefront/cart/coupon') {
    if (!cart) return err(404, 'cart_not_found', 'Cart not found.');
    if (method === 'DELETE') cart.coupon = null;
    else if (body.code === 'WINTER15' || body.code === 'FREESHIP') cart.coupon = body.code;
    else return err(422, 'coupon_invalid', "This code doesn't exist.", { code: ["This code doesn't exist."] });
    return json(200, { data: price(cart), meta: {} });
  }

  if (path === '/storefront/cart/shipping-options') {
    if (!cart) return err(404, 'cart_not_found', 'Cart not found.');
    const qq = quote(cart, q.get('district_code') ?? '', q.get('thana_code') ?? '');
    return qq ? json(200, { data: qq }) : err(422, 'validation_failed', 'Invalid.', { thana_code: ['Unknown area.'] });
  }

  if (path === '/storefront/checkout' && method === 'POST') {
    const key = h.get('Idempotency-Key');
    if (!key) return err(400, 'idempotency_key_required', 'Idempotency-Key is required.');
    const hash = JSON.stringify(body) + token;
    const prev = db.idem.get(key);
    if (prev) return prev.hash === hash ? json(201, prev.body, { 'Idempotent-Replayed': 'true' }) : err(409, 'idempotency_key_mismatch', 'Different request.');
    if (!cart) return err(404, 'cart_not_found', 'Cart not found.');
    const priced = price(cart);
    const bad = priced.lines.findIndex((l) => l.issue);
    if (bad >= 0) return err(422, 'out_of_stock', 'Out of stock.', { [`items.${bad}.quantity`]: ['Only a few left.'] });
    const contact = body.contact as { name: string; phone: string; email: string | null };
    const addr = body.shipping_address as Record<string, string | null>;
    const qq = quote(cart, String(addr.district_code), String(addr.thana_code));
    if (!qq) return err(422, 'validation_failed', 'Invalid.', { 'shipping_address.thana_code': ['Choose your upazila or thana.'] });
    const total = priced.estimated_total_amount + qq.amount;
    if (total !== body.expected_total_amount) return err(409, 'checkout_changed', 'Changed.', { expected_total_amount: [`The total changed to ৳ ${(total / 100).toLocaleString('en-US')}. Check your order and place it again.`] });
    for (const l of priced.lines) {
      const f = findVariant(l.variant_id)!;
      if (f.v.stock !== null) f.v.stock -= l.quantity;
    }
    const thana = GEO.thanas.find((t) => t.code === addr.thana_code)!;
    const district = GEO.districts.find((d) => d.code === addr.district_code)!;
    const number = `DE-${++db.seq}`;
    const confirmation = rand();
    const order = {
      number,
      status: 'pending',
      payment_method: 'cod',
      placed_at: new Date().toISOString(),
      customer_name: contact.name,
      customer_phone: contact.phone,
      shipping_address: { division_code: district.division_code, division: 'Dhaka', district_code: district.code, district: district.name, thana_code: thana.code, thana: thana.name, area: addr.area ?? null, address_line: addr.address_line, landmark: addr.landmark ?? null, label: addr.label ?? null },
      lines: priced.lines.map((l) => ({ product_name: l.product_name, variant_title: l.variant_title, quantity: l.quantity, image: l.image, unit_price_amount: l.unit_price_amount, total_amount: l.line_amount })),
      coupon_code: priced.coupon?.code ?? null,
      subtotal_amount: priced.subtotal_amount,
      discount_amount: priced.discount_amount,
      shipping_amount: qq.amount,
      total_amount: total,
      due_amount: total,
      currency: 'BDT',
      delivery: { zone_name: qq.zone_name, min_days: qq.min_days, max_days: qq.max_days },
    };
    db.orders.push({ number, phone: contact.phone, token: confirmation, order, status: 'pending' });
    db.carts.delete(token!);
    const res = { data: { order, confirmation_token: confirmation } };
    db.idem.set(key, { hash, body: res });
    return json(201, res);
  }

  if (path === '/storefront/orders/confirmation') {
    const o = db.orders.find((x) => x.token === h.get('X-Order-Token'));
    return o ? json(200, { data: o.order }) : err(404, 'not_found', 'Not found.');
  }

  if (path === '/storefront/orders/track' && method === 'POST') {
    const num = String(body.number).toUpperCase();
    const o = db.orders.find((x) => (x.number === num || x.number.endsWith(`-${num}`)) && x.phone === body.phone);
    if (!o) return err(404, 'not_found', 'Not found.');
    const ord = o.order as { placed_at: string; shipping_address: { district: string; thana: string }; lines: unknown[]; total_amount: number; due_amount: number };
    return json(200, {
      data: {
        number: o.number,
        status: o.status,
        placed_at: ord.placed_at,
        shipping: { district: ord.shipping_address.district, thana: ord.shipping_address.thana },
        lines: ord.lines,
        total_amount: ord.total_amount,
        due_amount: ord.due_amount,
        currency: 'BDT',
        timeline: [{ status: 'pending', at: ord.placed_at }],
        shipment: null,
      },
    });
  }

  return err(404, 'not_found', `mock: no route for ${method} ${path}`);
}
