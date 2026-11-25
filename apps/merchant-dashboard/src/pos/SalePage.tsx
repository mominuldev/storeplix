import { isApiError } from '@storeplix/api-client';
import type { OrderCustomerSummary, PosCatalogItem, PosCatalogVariant, PosQuote, PosQuoteInput, PosSale, PosSaleInput, PosSession } from '@storeplix/types';
import { Button, cn, formatBdt, formatCount, riskTierMeta, Spinner } from '@storeplix/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Barcode, Minus, Phone, Plus, Search, ShoppingCart, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { useCategories } from '../catalog/queries';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, errorMessage, LoadingRows, NoResults } from '../catalog/states';
import { Thumb, useDebounced } from '../catalog/ui';
import { newIdempotencyKey } from '../commerce/format';
import { api } from '../lib/api';
import { formatBdPhone, normalizeBdPhone } from '../lib/phone';
import { toast } from '../online-store/components/Toast';
import { handlePlanLimit } from '../plan/Banners';
import { useFeatures } from '../plan/useFeatures';
import { OnlinePill, PosBar, PosPlanNote } from './components';
import { isNetworkError, outOfStockLines } from './errors';
import { PaymentDialog, type PaymentSubmit } from './PaymentDialog';
import {
  addToCart,
  cartSignature,
  createAttemptKeys,
  estimateSubtotal,
  itemsCount,
  lineCaption,
  lineProblem,
  maxQuantity,
  posLocked,
  priceRange,
  productInStock,
  quickCash,
  setQuantity,
  stockCaption,
  tenderCards,
  sessionLine,
  vatLabel,
  type CartLine,
  type TenderMode,
} from './pos';
import { posKeys, useOnline, usePosCatalog, usePosCustomer, usePosQuote, usePosSession } from './queries';
import { SaleComplete } from './SaleComplete';
import { VariantPicker } from './VariantPicker';

// PHASE-8-8D §11.2 Sale 22:1737 (section 27:1026): POS bar (title, "{register} · {location} · Opened {time} by {name}",
// Online/Offline pill, Cash in drawer tile, Close register; Hold sale is part B and hidden). Catalog: search / scan box
// (Enter = exact SKU/barcode lookup; a match adds, else the text filters), barcode icon focuses the box, category chips,
// product tiles with stock at the register location. Cart "Current sale": customer (phone lookup / walk-in / new),
// lines with − qty +, totals from the server quote (Discount · {code} with "Add coupon", VAT per P88D-8, Total), method
// chips, quick cash chips, Charge. Hidden: "Scanner ready". 390 px (P88D-24): 2-column catalog, cart as a bottom sheet
// behind a sticky "Charge ৳ x · n items" bar.

type CustomerChoice = { kind: 'walk_in' } | { kind: 'phone'; text: string; name: string };

export default function SalePage() {
  const { sessionId } = useParams();
  const scope = useStoreScope();
  const session = usePosSession(sessionId, { poll: 30_000 });
  const locked = posLocked(useFeatures().data);

  if (session.isPending) {
    return (
      <div className="flex flex-1 flex-col">
        <PosBar subtitle="Loading register…" />
        <div className="p-6">
          <LoadingRows rows={6} label="Loading register" />
        </div>
      </div>
    );
  }
  if (session.isError) {
    return (
      <div className="flex flex-1 flex-col">
        <PosBar subtitle="Register" />
        <div className="p-6">
          <ErrorBlock error={session.error} title="We couldn’t load this register" onRetry={() => session.refetch()} />
          <Link to="/pos" className="mt-3 inline-block text-body font-medium text-brand-600">
            Back to registers
          </Link>
        </div>
      </div>
    );
  }
  if (session.data.status === 'closed') return <Navigate to="/pos" replace />;
  if (locked) {
    return (
      <div className="flex flex-1 flex-col">
        <PosBar subtitle={sessionLine(session.data)}>
          <Link to={`/pos/${session.data.id}/close`} className="rounded-md border border-border-default px-4 py-2 text-body font-semibold">
            Close register
          </Link>
        </PosBar>
        <div className="p-4 lg:p-6">
          <PosPlanNote canSeePlans={scope.canViewBilling} />
        </div>
      </div>
    );
  }
  return <Till session={session.data} />;
}

function Till({ session }: { session: PosSession }) {
  const scope = useStoreScope();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const browserOnline = useOnline();
  // P88D-21 "last request": a network failure marks the till offline until the browser reports online again or a
  // probe of the session (every 5 s while down) succeeds.
  const [netDownAt, setNetDownAt] = useState<number | null>(null);
  const probe = usePosSession(session.id, { poll: netDownAt ? 5_000 : false });
  const netDown = netDownAt !== null && probe.dataUpdatedAt <= netDownAt;
  const setNetDown = (down: boolean) => setNetDownAt(down ? Date.now() : null);
  useEffect(() => {
    const on = () => setNetDownAt(null);
    window.addEventListener('online', on);
    return () => window.removeEventListener('online', on);
  }, []);
  const online = browserOnline && !netDown;

  // ---- Cart ----
  const [lines, setLines] = useState<CartLine[]>([]);
  const [customer, setCustomer] = useState<CustomerChoice>({ kind: 'walk_in' });
  const [coupon, setCoupon] = useState<string | null>(null);
  const [couponOpen, setCouponOpen] = useState(false);
  const [couponText, setCouponText] = useState('');
  const [mode, setMode] = useState<TenderMode>('cash');
  const [lineErrors, setLineErrors] = useState<Record<string, string>>({});
  const [cartNotice, setCartNotice] = useState<string | null>(null);

  const phone = customer.kind === 'phone' ? normalizeBdPhone(customer.text) : null;
  const lookup = usePosCustomer(phone);
  const known: OrderCustomerSummary | null = lookup.data ?? null;

  const quoteInput: PosQuoteInput | null = useMemo(
    () =>
      lines.length
        ? {
            session_id: session.id,
            lines: lines.map((l) => ({
              variant_id: l.variantId,
              quantity: l.quantity,
            })),
            coupon_code: coupon,
            customer_phone: phone,
          }
        : null,
    [lines, coupon, phone, session.id],
  );
  const debouncedInput = useDebounced(quoteInput, 250);
  const quote = usePosQuote(debouncedInput);
  const signature = cartSignature(lines, coupon, phone);
  const quoteFresh =
    !!quote.data &&
    !quote.isPlaceholderData &&
    !quote.isFetching &&
    !!debouncedInput &&
    cartSignature(
      debouncedInput.lines.map((l) => ({
        variantId: l.variant_id,
        quantity: l.quantity,
      })),
      debouncedInput.coupon_code ?? null,
      debouncedInput.customer_phone ?? null,
    ) === signature;
  const couponError = coupon && quote.isError && isApiError(quote.error) && quote.error.code.startsWith('coupon') ? quote.error.message : null;
  const hasProblems = lines.some((l) => lineProblem(quote.data, l.variantId) || lineErrors[l.variantId]);
  const total = quoteFresh ? quote.data!.total_amount : null;
  const count = itemsCount(lines);
  const canCharge = lines.length > 0 && quoteFresh && !hasProblems && online && (customer.kind === 'walk_in' || (!!phone && !lookup.isFetching));

  const resetSale = useCallback(() => {
    setLines([]);
    setCustomer({ kind: 'walk_in' });
    setCoupon(null);
    setCouponOpen(false);
    setCouponText('');
    setMode('cash');
    setLineErrors({});
    setCartNotice(null);
  }, []);

  const add = (item: PosCatalogItem, variant: PosCatalogVariant, quantity = 1) => {
    const r = addToCart(lines, item, variant, quantity);
    if (r.error) return toast(r.error, 'error');
    setLines(r.lines);
    setCartNotice(null);
  };
  const changeQty = (variantId: string, q: number) => {
    setLines(setQuantity(lines, variantId, q));
    setLineErrors(({ [variantId]: _drop, ...rest }) => rest);
  };

  // ---- Catalog ----
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 300);
  const [categoryId, setCategoryId] = useState('');
  const [picking, setPicking] = useState<PosCatalogItem | null>(null);
  const catalog = usePosCatalog(session.register.id, q, categoryId);
  const categories = useCategories();
  const searchRef = useRef<HTMLInputElement>(null);
  const items = catalog.data?.pages.flatMap((p) => p.data) ?? [];

  const pickProduct = (item: PosCatalogItem) => {
    if (!productInStock(item)) return;
    if (item.variants.length === 1) return add(item, item.variants[0]!);
    setPicking(item);
  };

  const scan = async () => {
    const code = search.trim();
    if (!code || code.length > 64) return;
    try {
      const item = await api.pos.lookup(scope.storeId!, {
        register_id: session.register.id,
        code,
      });
      const variant = item.variants[0];
      if (variant) {
        add(item, variant);
        setSearch('');
      }
    } catch (e) {
      if (isNetworkError(e)) setNetDown(true);
      // 404 `pos_code_not_found`: keep the text as a filter (§11.2).
    }
  };

  // ---- Payment and sale ----
  const [paying, setPaying] = useState<{ initialCash: number | null } | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  const [done, setDone] = useState<{ sale: PosSale; print: boolean } | null>(null);
  const attempts = useRef(createAttemptKeys(newIdempotencyKey));

  const sale = useMutation({
    mutationFn: ({ input }: { input: PosSaleInput; print: boolean }) => api.pos.sales.create(scope.storeId!, input, attempts.current.keyFor(JSON.stringify(input))),
    onSuccess: (result, { print }) => {
      attempts.current.reset();
      setNetDown(false);
      setPaying(null);
      setPayError(null);
      setDone({ sale: result, print });
      resetSale();
      void qc.invalidateQueries({
        queryKey: posKeys.session(scope, session.id),
      });
      void qc.invalidateQueries({
        queryKey: [scope.tenantId, scope.storeId, 'pos', 'catalog'],
      });
    },
    onError: (e) => {
      // The attempt key is kept: retrying the same sale replays it instead of selling twice (S200).
      if (isNetworkError(e)) {
        setNetDown(true);
        return setPayError('We couldn’t reach the server. Check the connection and tap Complete again — the sale won’t be charged twice.');
      }
      if (handlePlanLimit(e)) return setPaying(null);
      const code = isApiError(e) ? e.code : '';
      if (code === 'register_closed') {
        toast('This register was closed. Open it again to keep selling.', 'error');
        return navigate('/pos');
      }
      if (code === 'checkout_changed') {
        setPaying(null);
        setCartNotice('Prices or the coupon changed. Check the new total, then charge again.');
        return void quote.refetch();
      }
      if (code === 'out_of_stock') {
        const byIndex = outOfStockLines(e);
        setLineErrors(Object.fromEntries(Object.entries(byIndex).flatMap(([i, m]) => (lines[Number(i)] ? [[lines[Number(i)]!.variantId, m]] : []))));
        setPaying(null);
        return setCartNotice('Some items are short at this shop. Fix the cart, then charge again.');
      }
      setPayError(errorMessage(e, 'We couldn’t complete the sale.'));
    },
  });

  const submitPayment = ({ tender, print, sms }: PaymentSubmit) => {
    if (!quote.data || total === null) return;
    const input: PosSaleInput = {
      session_id: session.id,
      lines: lines.map((l) => ({
        variant_id: l.variantId,
        quantity: l.quantity,
      })),
      coupon_code: coupon,
      expected_total_amount: total,
      payments: tender.payments,
      tendered_cash_amount: tender.tendered,
      sms_receipt: sms,
      ...(customer.kind === 'phone' && phone
        ? known?.id
          ? { customer_id: known.id }
          : {
              customer: {
                phone,
                name: (known?.name ?? customer.name).trim() || null,
              },
            }
        : {}),
    };
    setPayError(null);
    sale.mutate({ input, print });
  };

  const openPayment = (initialCash: number | null = null) => {
    if (!canCharge) return;
    setPayError(null);
    setPaying({ initialCash });
  };

  const refreshCart = () => {
    setLineErrors({});
    setCartNotice(null);
    void quote.refetch();
    void qc.invalidateQueries({
      queryKey: [scope.tenantId, scope.storeId, 'pos', 'catalog'],
    });
  };

  const [sheet, setSheet] = useState(false);
  const customerLabel = customer.kind === 'phone' && phone ? (known?.name ?? customer.name) || formatBdPhone(phone) : 'Walk-in customer';

  const cart = (
    <CartPanel
      lines={lines}
      quote={lines.length && (quoteFresh || quote.isPlaceholderData) ? quote.data : undefined}
      quoteLoading={!!lines.length && !quoteFresh && !quote.isError}
      quoteError={quote.isError && !couponError ? errorMessage(quote.error, 'We couldn’t price the cart.') : null}
      lineErrors={lineErrors}
      notice={cartNotice}
      onRefresh={refreshCart}
      onQty={changeQty}
      onClear={() => {
        if (lines.length === 0 || window.confirm('Clear the current sale?')) resetSale();
      }}
      customer={
        <CustomerRow
          choice={customer}
          onChange={setCustomer}
          known={known}
          loading={lookup.isFetching}
          error={lookup.isError ? errorMessage(lookup.error, 'We couldn’t look up this phone.') : null}
        />
      }
      coupon={{
        code: coupon,
        open: couponOpen,
        text: couponText,
        error: couponError,
        setText: setCouponText,
        setOpen: setCouponOpen,
        apply: (c) => setCoupon(c),
        remove: () => setCoupon(null),
      }}
      mode={mode}
      onMode={setMode}
      total={total}
      onQuickCash={(v) => {
        setMode('cash');
        openPayment(v);
      }}
      canCharge={canCharge}
      online={online}
      onCharge={() => openPayment()}
      count={count}
    />
  );

  return (
    <div className="flex flex-1 flex-col md:h-[calc(100dvh-var(--sp-banner-h,0px))] md:min-h-0">
      <PosBar subtitle={sessionLine(session)}>
        <OnlinePill online={online} />
        <div className="flex flex-col rounded-md bg-surface-subtle px-3 py-1.5">
          <span className="text-caption text-text-secondary">Cash in drawer</span>
          <span className="text-body font-semibold text-text-primary" data-testid="pos-cash-in-drawer">
            {formatBdt(session.totals.cash_in_drawer_amount)}
          </span>
        </div>
        <Button variant="secondary" onClick={() => navigate(`/pos/${session.id}/close`)} data-testid="pos-close-register">
          Close register
        </Button>
      </PosBar>

      <div className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-5 pb-28 md:pb-6 lg:px-6" aria-label="Catalog">
          <form
            role="search"
            className="flex h-12 shrink-0 items-center gap-2.5 rounded-lg border border-border-default bg-surface-card px-3.5 shadow-elevation-1 focus-within:border-brand-600"
            onSubmit={(e) => {
              e.preventDefault();
              void scan();
            }}
          >
            <Search aria-hidden className="size-[18px] text-text-muted" />
            <input
              ref={searchRef}
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search products or scan a barcode"
              aria-label="Search products or scan a barcode"
              maxLength={120}
              data-testid="pos-search"
              className="min-w-0 flex-1 bg-transparent text-body-lg text-text-primary outline-none placeholder:text-text-muted"
            />
            <button type="button" aria-label="Scan a barcode" className="text-text-primary" onClick={() => searchRef.current?.focus()}>
              <Barcode aria-hidden className="size-5" />
            </button>
          </form>

          <div className="-mx-4 flex shrink-0 gap-2 overflow-x-auto px-4 lg:-mx-6 lg:px-6" role="tablist" aria-label="Categories">
            {[{ id: '', name: 'All' }, ...(categories.data ?? [])].map((c) => (
              <button
                key={c.id || 'all'}
                type="button"
                role="tab"
                aria-selected={categoryId === c.id}
                onClick={() => setCategoryId(c.id)}
                className={cn(
                  'shrink-0 rounded-full px-3.5 py-2 text-body font-medium whitespace-nowrap',
                  categoryId === c.id ? 'bg-text-primary text-text-inverse' : 'border border-border-default bg-surface-card text-text-primary hover:bg-surface-subtle',
                )}
              >
                {c.name}
              </button>
            ))}
          </div>

          {catalog.isPending ? (
            <LoadingRows rows={4} label="Loading products" />
          ) : catalog.isError ? (
            <ErrorBlock error={catalog.error} title="We couldn’t load products" onRetry={() => catalog.refetch()} />
          ) : items.length === 0 ? (
            <NoResults
              title={q || categoryId ? 'No products match — try another name or scan the barcode' : 'No products to sell yet'}
              description={q || categoryId ? undefined : 'Active products show here with their stock at this shop.'}
              onClear={q || categoryId ? () => (setSearch(''), setCategoryId('')) : undefined}
            />
          ) : (
            <>
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4" data-testid="pos-catalog">
                {items.map((item) => {
                  const stock = stockCaption(item);
                  const inStock = productInStock(item);
                  const inCart = lines.some((l) => l.productId === item.product_id);
                  return (
                    <li key={item.product_id}>
                      <button
                        type="button"
                        disabled={!inStock}
                        onClick={() => pickProduct(item)}
                        aria-label={`${item.name}, ${formatBdt(priceRange(item))}, ${stock.text}`}
                        className={cn(
                          'flex w-full flex-col gap-2 rounded-[14px] bg-surface-card p-2.5 text-left outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50',
                          inCart ? 'border-2 border-brand-600' : 'border border-border-default hover:border-border-strong',
                        )}
                      >
                        <span className="flex h-28 w-full items-center justify-center overflow-hidden rounded-[10px] bg-surface-subtle">
                          {item.image_url ? (
                            <img src={item.image_url} alt="" loading="lazy" className="size-full object-cover" />
                          ) : (
                            <ShoppingCart aria-hidden className="size-6 text-text-muted" />
                          )}
                        </span>
                        <span className="w-full truncate text-body font-semibold text-text-primary">{item.name}</span>
                        <span className="flex w-full items-baseline gap-2">
                          <span className="text-body font-semibold text-brand-700">{formatBdt(priceRange(item))}</span>
                          <span className={cn('ml-auto text-caption', stock.tone === 'danger' ? 'text-danger' : stock.tone === 'warning' ? 'text-warning' : 'text-text-muted')}>
                            {stock.text}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {catalog.hasNextPage && (
                <Button variant="secondary" className="self-center" disabled={catalog.isFetchingNextPage} onClick={() => void catalog.fetchNextPage()}>
                  {catalog.isFetchingNextPage ? 'Loading…' : 'Load more products'}
                </Button>
              )}
            </>
          )}
        </section>

        <aside className="hidden w-[380px] shrink-0 flex-col overflow-y-auto border-l border-border-default bg-surface-card p-5 md:flex xl:w-[420px]" aria-label="Current sale">
          {cart}
        </aside>
      </div>

      {/* P88D-24: sticky Charge bar + bottom sheet below md. */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border-default bg-surface-card px-4 pt-2 pb-[max(12px,env(safe-area-inset-bottom))] md:hidden">
        <Button fullWidth className="min-h-12 text-body-lg" disabled={lines.length === 0} onClick={() => setSheet(true)} data-testid="pos-mobile-charge-bar">
          {lines.length === 0 ? 'Cart is empty' : `Charge ${total === null ? '…' : formatBdt(total)} · ${plural(count, 'item')}`}
        </Button>
      </div>
      {sheet && (
        <div
          className="fixed inset-0 z-30 flex flex-col justify-end bg-text-primary/40 md:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Current sale"
          onClick={(e) => e.target === e.currentTarget && setSheet(false)}
        >
          <div className="flex max-h-[92dvh] flex-col overflow-y-auto rounded-t-card bg-surface-card p-4 pb-[max(16px,env(safe-area-inset-bottom))]">
            <button type="button" aria-label="Close cart" className="mb-2 self-end text-text-muted" onClick={() => setSheet(false)}>
              <X aria-hidden className="size-5" />
            </button>
            {cart}
          </div>
        </div>
      )}

      {picking && (
        <VariantPicker
          item={picking}
          inCart={(id) => lines.find((l) => l.variantId === id)?.quantity ?? 0}
          onClose={() => setPicking(null)}
          onAdd={(variant, quantity) => {
            add(picking, variant, quantity);
            setPicking(null);
          }}
        />
      )}
      {paying && quote.data && total !== null && (
        <PaymentDialog
          total={total}
          subtotal={quote.data.subtotal_amount}
          discount={quote.data.discount_amount}
          couponCode={quote.data.coupon_code}
          subtitle={`${customerLabel} · ${plural(count, 'item')} · ${session.register.name}`}
          hasPhone={customer.kind === 'phone' && !!phone}
          initialMode={mode}
          initialCash={paying.initialCash}
          online={online}
          pending={sale.isPending}
          error={payError}
          onClose={() => !sale.isPending && setPaying(null)}
          onSubmit={submitPayment}
        />
      )}
      {done && (
        <SaleComplete
          sale={done.sale}
          autoPrint={done.print}
          onNewSale={() => {
            setDone(null);
            setSheet(false);
            searchRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}

const plural = (n: number, one: string) => `${formatCount(n)} ${n === 1 ? one : `${one}s`}`;

interface CouponState {
  code: string | null;
  open: boolean;
  text: string;
  error: string | null;
  setText: (t: string) => void;
  setOpen: (o: boolean) => void;
  apply: (code: string) => void;
  remove: () => void;
}

function CartPanel(props: {
  lines: CartLine[];
  quote: PosQuote | undefined;
  quoteLoading: boolean;
  quoteError: string | null;
  lineErrors: Record<string, string>;
  notice: string | null;
  onRefresh: () => void;
  onQty: (variantId: string, q: number) => void;
  onClear: () => void;
  customer: React.ReactNode;
  coupon: CouponState;
  mode: TenderMode;
  onMode: (m: TenderMode) => void;
  total: number | null;
  onQuickCash: (v: number) => void;
  canCharge: boolean;
  online: boolean;
  onCharge: () => void;
  count: number;
}) {
  const { lines, quote, coupon } = props;
  const subtotal = quote?.subtotal_amount ?? estimateSubtotal(lines);
  const vat = quote ? vatLabel('en', quote.vat) : null;
  return (
    <div className="flex flex-1 flex-col gap-3.5" data-testid="pos-cart">
      <div className="flex items-center">
        <h2 className="flex-1 text-body-lg font-medium text-text-primary">Current sale</h2>
        {lines.length > 0 && (
          <button type="button" className="text-body font-medium text-danger hover:underline" onClick={props.onClear}>
            Clear
          </button>
        )}
      </div>
      {props.customer}

      {props.notice && (
        <div className="flex items-center gap-2 rounded-lg bg-warning-bg px-3 py-2 text-body text-warning" role="alert" data-testid="pos-cart-notice">
          <span className="flex-1">{props.notice}</span>
          <button type="button" className="font-medium underline" onClick={props.onRefresh}>
            Refresh cart
          </button>
        </div>
      )}

      {lines.length === 0 ? (
        <p className="py-8 text-center text-body text-text-muted">Tap a product or scan a barcode to start a sale.</p>
      ) : (
        <ul className="flex flex-col">
          {lines.map((l) => {
            const problem = props.lineErrors[l.variantId] ?? lineProblem(quote, l.variantId);
            const qLine = quote?.lines.find((x) => x.variant_id === l.variantId);
            return (
              <li key={l.variantId} className="flex flex-col gap-1 border-b border-border-default py-2.5" data-testid="pos-cart-line">
                <div className="flex items-center gap-3">
                  <Thumb src={l.imageUrl} size={44} />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-body font-semibold text-text-primary">{l.name}</span>
                    <span className="truncate text-caption text-text-secondary">
                      {lineCaption({
                        variantTitle: l.variantTitle,
                        unitPrice: qLine?.unit_price_amount ?? l.unitPrice,
                      })}
                    </span>
                  </div>
                  <div className="flex items-center rounded-md border border-border-default">
                    <button
                      type="button"
                      aria-label={`Decrease ${l.name}`}
                      className="flex size-[30px] items-center justify-center"
                      onClick={() => props.onQty(l.variantId, l.quantity - 1)}
                    >
                      <Minus aria-hidden className="size-3.5" />
                    </button>
                    <span className="w-[30px] text-center text-body font-semibold" data-testid="pos-line-qty">
                      {l.quantity}
                    </span>
                    <button
                      type="button"
                      aria-label={`Increase ${l.name}`}
                      className="flex size-[30px] items-center justify-center disabled:opacity-40"
                      disabled={l.quantity >= maxQuantity(l.available)}
                      onClick={() => props.onQty(l.variantId, l.quantity + 1)}
                    >
                      <Plus aria-hidden className="size-3.5" />
                    </button>
                  </div>
                </div>
                {problem && (
                  <p className="flex items-center gap-2 text-caption text-danger" role="alert">
                    {problem}
                    <button type="button" className="font-medium underline" onClick={props.onRefresh}>
                      Refresh cart
                    </button>
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex-1" />

      <div className="flex flex-col gap-2 rounded-lg bg-surface-canvas px-3.5 py-3" data-testid="pos-totals">
        <div className="flex text-body">
          <span className="flex-1 text-text-secondary">Subtotal · {plural(props.count, 'item')}</span>
          <span className="font-medium text-text-primary">{formatBdt(subtotal)}</span>
        </div>
        {coupon.code && !coupon.error ? (
          <div className="flex text-body">
            <span className="flex-1 text-text-secondary">
              Discount · {coupon.code}{' '}
              <button type="button" className="text-caption text-brand-600 hover:underline" onClick={coupon.remove}>
                Remove
              </button>
            </span>
            <span className="font-medium text-success">− {formatBdt(quote?.discount_amount ?? 0)}</span>
          </div>
        ) : coupon.open ? (
          <form
            className="flex flex-col gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              const c = coupon.text.trim().toUpperCase();
              if (c) coupon.apply(c);
            }}
          >
            <div className="flex gap-2">
              <input
                aria-label="Coupon code"
                value={coupon.text}
                maxLength={40}
                onChange={(e) => coupon.setText(e.target.value)}
                placeholder="Coupon code"
                className="h-9 min-w-0 flex-1 rounded-md border border-border-default bg-surface-card px-3 text-body uppercase outline-none focus-visible:border-brand-600"
              />
              <Button size="sm" type="submit">
                Apply
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  coupon.remove();
                  coupon.setOpen(false);
                }}
              >
                Cancel
              </Button>
            </div>
            {coupon.error && (
              <p className="text-caption text-danger" role="alert">
                {coupon.error}
              </p>
            )}
          </form>
        ) : (
          <button type="button" className="self-start text-body font-medium text-brand-600 hover:underline" onClick={() => coupon.setOpen(true)}>
            Add coupon
          </button>
        )}
        {vat && quote?.vat && (
          <div className="flex text-body">
            <span className="flex-1 text-text-secondary">{vat}</span>
            <span className="font-medium text-text-primary">{formatBdt(quote.vat.amount)}</span>
          </div>
        )}
        <div className="flex items-center border-t border-border-default pt-1.5">
          <span className="flex-1 text-body-lg font-medium text-text-primary">Total</span>
          {props.quoteLoading && <Spinner size="sm" label="Pricing" />}
          <span className="ml-2 text-heading-24 text-text-primary" data-testid="pos-total">
            {props.total === null ? (quote ? formatBdt(quote.total_amount) : '—') : formatBdt(props.total)}
          </span>
        </div>
        {props.quoteError && (
          <p className="text-caption text-danger" role="alert">
            {props.quoteError}{' '}
            <button type="button" className="font-medium underline" onClick={props.onRefresh}>
              Refresh cart
            </button>
          </p>
        )}
      </div>

      <span className="text-body font-medium text-text-secondary">Payment</span>
      <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="Payment method">
        {tenderCards.map((c) => (
          <button
            key={c.mode}
            type="button"
            role="radio"
            aria-checked={props.mode === c.mode}
            onClick={() => props.onMode(c.mode)}
            className={cn(
              'rounded-[10px] py-2.5 text-body font-semibold',
              props.mode === c.mode
                ? 'border-2 border-brand-600 bg-brand-50 text-brand-700'
                : 'border border-border-default bg-surface-card text-text-primary hover:bg-surface-subtle',
            )}
          >
            {c.label}
          </button>
        ))}
      </div>
      {props.total !== null && (
        <div className="grid grid-cols-3 gap-2">
          {[props.total, ...quickCash(props.total, 2)].map((v) => (
            <button
              key={v}
              type="button"
              disabled={!props.canCharge}
              onClick={() => props.onQuickCash(v)}
              className="rounded-md bg-surface-subtle py-2 text-body font-medium text-text-primary hover:bg-border-default disabled:opacity-50"
            >
              {formatBdt(v)}
            </button>
          ))}
        </div>
      )}
      <Button className="min-h-[60px] rounded-lg text-heading" disabled={!props.canCharge} onClick={props.onCharge} data-testid="pos-charge">
        {props.total === null ? 'Charge' : `Charge ${formatBdt(props.total)}`}
      </Button>
      <p className="text-center text-caption text-text-muted">{props.online ? 'Receipt prints on 80 mm · SMS receipt to customer' : 'Offline — reconnect to charge'}</p>
    </div>
  );
}

/** Customer row: walk-in by default; phone → exact lookup card ("{name} · {phone}", "{n} orders · ৳ x spent · {tier}") or a new customer name. */
function CustomerRow({
  choice,
  onChange,
  known,
  loading,
  error,
}: {
  choice: CustomerChoice;
  onChange: (c: CustomerChoice) => void;
  known: OrderCustomerSummary | null;
  loading: boolean;
  error: string | null;
}) {
  if (choice.kind === 'walk_in') {
    return (
      <div className="flex items-center gap-2.5 rounded-[10px] bg-surface-canvas px-3 py-2.5" data-testid="pos-customer">
        <Phone aria-hidden className="size-4 text-text-secondary" />
        <span className="flex-1 text-body font-medium text-text-primary">Walk-in customer</span>
        <button type="button" className="text-caption font-medium text-brand-600 hover:underline" onClick={() => onChange({ kind: 'phone', text: '', name: '' })}>
          Add customer
        </button>
      </div>
    );
  }
  const phone = normalizeBdPhone(choice.text);
  if (phone && known && !loading) {
    return (
      <div className="flex items-center gap-2.5 rounded-[10px] bg-surface-canvas px-3 py-2.5" data-testid="pos-customer">
        <Phone aria-hidden className="size-4 text-text-secondary" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body font-medium text-text-primary">
            {known.name} · {formatBdPhone(known.phone || phone)}
          </span>
          <span className="truncate text-caption text-text-secondary">
            {plural(known.orders_count, 'order')} · {formatBdt(known.total_spent_amount)} spent · {riskTierMeta[known.risk.tier].label}
          </span>
        </div>
        <button type="button" className="text-caption font-medium text-brand-600 hover:underline" onClick={() => onChange({ kind: 'phone', text: '', name: '' })}>
          Change
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-[10px] bg-surface-canvas px-3 py-2.5" data-testid="pos-customer">
      <div className="flex items-center gap-2">
        <Phone aria-hidden className="size-4 text-text-secondary" />
        <input
          inputMode="tel"
          autoFocus
          aria-label="Customer phone"
          placeholder="Customer phone (01XXXXXXXXX)"
          value={choice.text}
          onChange={(e) => onChange({ ...choice, text: e.target.value })}
          className="h-9 min-w-0 flex-1 rounded-md border border-border-default bg-surface-card px-3 text-body outline-none focus-visible:border-brand-600"
        />
        {loading && <Spinner size="sm" label="Looking up" />}
        <button type="button" className="text-caption font-medium text-brand-600 hover:underline" onClick={() => onChange({ kind: 'walk_in' })}>
          Walk-in
        </button>
      </div>
      {choice.text.trim() && !phone && <p className="text-caption text-danger">Enter a Bangladesh mobile number, e.g. 01711-552211.</p>}
      {error && <p className="text-caption text-danger">{error}</p>}
      {phone && !loading && !known && !error && (
        <input
          aria-label="New customer name"
          placeholder="New customer — name (optional)"
          maxLength={120}
          value={choice.name}
          onChange={(e) => onChange({ ...choice, name: e.target.value })}
          className="h-9 rounded-md border border-border-default bg-surface-card px-3 text-body outline-none focus-visible:border-brand-600"
        />
      )}
    </div>
  );
}
