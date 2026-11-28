import type { CustomerSmsEvent, OrderStatus, StoreSettings, UpdateStoreSettingsInput } from '@storeplix/types';
import { isApiError } from '@storeplix/api-client';
import type { PaymentGatewayAccount } from '@storeplix/types';
import { Badge, Button, buttonVariants, Chip, cn, Input, OrderStatusBadge, orderStatusMeta, Spinner, Toggle } from '@storeplix/ui';
import { useMutation } from '@tanstack/react-query';
import { CreditCard, LifeBuoy, Mail, ReceiptText, Shield, Truck } from 'lucide-react';
import { Link } from 'react-router';
import { useState, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, errorMessage } from '../catalog/states';
import { api } from '../lib/api';
import { toast } from '../online-store/components/Toast';
import { ALL_GATEWAYS, byProvider, gatewayMeta, integrationStatusMeta, isConnected, isUsable, modeLabel } from '../payments/gateways';
import { usePaymentGateways, usePaymentInvalidate } from '../payments/queries';
import { FormAlert } from '../onboarding/AuthShell';
import { useSmsTemplates } from '../sms/queries';
import { canOpenSms } from '../sms/sms';
import { smsPreview, useSaveSettings, useStoreSettings, vatIncluded } from './commerceSettings';
import { SettingsCard, SettingsToggleRow } from './SettingsLayout';
import { GatewayLogo } from '../payments/GatewayLogo';

// Settings → Payments & checkout 60:14865, Notifications 60:15863, Taxes & invoices 60:16858 (Phase 5a parts).

function Gate({ children }: { children: (s: StoreSettings) => ReactNode }) {
  const settings = useStoreSettings();
  if (settings.isPending)
    return (
      <div className="flex justify-center py-16">
        <Spinner label="Loading settings" />
      </div>
    );
  if (settings.isError || !settings.data.commerce) return <ErrorBlock error={settings.error} onRetry={() => void settings.refetch()} />;
  return <>{children(settings.data)}</>;
}

function Heading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="text-heading text-text-primary">{title}</h2>
      <p className="text-body text-text-secondary">{subtitle}</p>
    </div>
  );
}

function ReadOnlyNote({ show }: { show: boolean }) {
  return show ? <p className="rounded-md bg-surface-subtle px-3 py-2 text-body text-text-secondary">Only owners and managers can change these settings.</p> : null;
}

type Tint = 'brand' | 'success' | 'info' | 'neutral';
const tints: Record<Tint, string> = {
  brand: 'bg-brand-50 text-brand-600',
  success: 'bg-success-bg text-success',
  info: 'bg-info-bg text-info',
  neutral: 'bg-surface-subtle text-text-secondary',
};

function IconTile({ tint = 'neutral', children }: { tint?: Tint; children: ReactNode }) {
  return <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg [&_svg]:size-5', tints[tint])}>{children}</span>;
}

// Figma "Method" row (60:14865): 1px brand-100 border, radius 12, padding 16, gap 16, 40 px tinted icon tile,
// 14/20 semibold title + 14/20 secondary description, gap 2.
function ToggleRow({ icon, tint, title, hint, children, disabled }: { icon?: ReactNode; tint?: Tint; title: ReactNode; hint?: ReactNode; children: ReactNode; disabled?: boolean }) {
  return (
    <div className={cn('flex items-center gap-4 rounded-lg border border-brand-100 p-4', disabled && 'opacity-60')}>
      {icon && <IconTile tint={tint}>{icon}</IconTile>}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-body font-semibold text-text-primary">{title}</span>
        {hint && <span className="text-body text-text-secondary">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

/**
 * Payments & checkout 60:14865 (5b-2): COD toggle; Advance delivery charge (`checkout.cod_advance`, needs a gateway
 * that's connected and on at checkout); Full online payment = per-gateway "on at checkout" toggles (`PATCH enabled`,
 * O A `ManageIntegrations`); Connected gateways list + "Manage in Integrations". Not built (§14): 2 % online
 * discount, Advance payment rules, WhatsApp link delivery, Order form fields, OTP, settlement text.
 */
export function PaymentsSettingsPage() {
  const { canManageSettings, canManageIntegrations } = useStoreScope();
  const save = useSaveSettings('Payment settings saved.');
  const gateways = usePaymentGateways();
  const invalidate = usePaymentInvalidate();
  const { storeId } = useStoreScope();
  const toggleGateway = useMutation({
    mutationFn: (a: PaymentGatewayAccount) => api.paymentGateways.update(storeId!, a.provider, { revision: a.revision, enabled: !a.enabled }),
    onSuccess: async (a) => {
      toast(a.enabled ? `${gatewayMeta[a.provider].short} is on at checkout.` : `${gatewayMeta[a.provider].short} is off at checkout.`);
      await invalidate.gateways();
    },
    onError: async (e) => {
      await invalidate.gateways();
      toast(isApiError(e) && e.code === 'revision_conflict' ? 'Someone else changed this gateway. We loaded the latest.' : errorMessage(e, 'We couldn’t change this gateway.'), 'error');
    },
  });
  const connected = (gateways.data ?? []).filter(isConnected);
  const usable = connected.filter(isUsable);
  return (
    <Gate>
      {(s) => {
        const advance = s.commerce.checkout.cod_advance === 'delivery_charge';
        return (
          <>
            <Heading title="Payments & checkout" subtitle="Choose how customers pay. Online payments are confirmed automatically by your gateway — no TrxID checking." />
            <ReadOnlyNote show={!canManageSettings} />
            <SettingsCard title="Checkout payment methods" description="Customers choose one of these at checkout. Turn on at least one." className="gap-3">
              <ToggleRow icon={<Truck />} tint="brand" title={<TitleWithBadge title="Cash on delivery" badge={<Badge>Most used</Badge>} />} hint="The rider collects cash. Your courier sends the money to you after delivery.">
                <Toggle
                  label="Cash on delivery"
                  checked={s.commerce.checkout.cod_enabled}
                  disabled={!canManageSettings || save.isPending}
                  onChange={(on) => save.mutate({ checkout: { cod_enabled: on } })}
                />
              </ToggleRow>
              {!s.commerce.checkout.cod_enabled && usable.length === 0 && <FormAlert>With cash on delivery off and no gateway on, customers can’t place orders.</FormAlert>}
              <ToggleRow
                icon={<CreditCard />}
                tint="success"
                title={<TitleWithBadge title="Advance delivery charge" badge={<Badge tone="success">Recommended</Badge>} />}
                hint={usable.length ? 'Customer pays only the delivery charge online before you ship. Cuts fake orders.' : 'Connect bKash or SSLCommerz and turn it on at checkout first.'}
                disabled={!usable.length && !advance}
              >
                <Toggle
                  label="Advance delivery charge"
                  checked={advance}
                  disabled={!canManageSettings || save.isPending || (!usable.length && !advance)}
                  onChange={(on) => save.mutate({ checkout: { cod_advance: on ? 'delivery_charge' : 'none' } })}
                />
              </ToggleRow>
              <div className="flex flex-col gap-3 rounded-lg border border-brand-100 p-4">
                <div className="flex items-center gap-4">
                  <IconTile tint="info">
                    <Shield />
                  </IconTile>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-body font-semibold text-text-primary">Full online payment</span>
                    <span className="text-body text-text-secondary">Customer pays the full amount with bKash, Nagad, card or net banking through your gateway.</span>
                  </span>
                </div>
                {gateways.isPending ? (
                  <Spinner label="Loading gateways" />
                ) : gateways.isError ? (
                  <ErrorBlock title="We couldn’t load your gateways" error={gateways.error} onRetry={() => void gateways.refetch()} />
                ) : connected.length === 0 ? (
                  <p className="text-body text-text-secondary">
                    No gateway connected yet.{' '}
                    <Link to="/integrations" className="font-medium text-brand-600">
                      Connect one in Integrations
                    </Link>
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {connected.map((a) => (
                      <li key={a.provider} className="flex items-center gap-3 rounded-md bg-surface-subtle px-3 py-2">
                        <GatewayLogo provider={a.provider} size="sm" />
                        <span className="min-w-0 flex-1 truncate text-body text-text-primary">{gatewayMeta[a.provider].checkoutLabel}</span>
                        <Toggle
                          label={`${gatewayMeta[a.provider].short} at checkout`}
                          checked={a.enabled}
                          disabled={!canManageIntegrations || toggleGateway.isPending}
                          onChange={() => toggleGateway.mutate(a)}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <p className="flex items-center gap-2.5 rounded-lg bg-info-bg px-4 py-3 text-body text-text-primary">
                <Shield aria-hidden className="size-[18px] shrink-0 text-info" /> Paid orders move to Confirmed on their own when the gateway confirms the payment. Failed or cancelled payments stay Unpaid.
              </p>
            </SettingsCard>
            <SettingsCard
              title="Connected gateways"
              description="Online payments go straight to your gateway account. Settlement follows each gateway’s schedule."
              className="gap-3"
              action={
                <Link to="/integrations" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
                  Manage in Integrations ↗
                </Link>
              }
            >
              {gateways.isPending ? (
                <Spinner label="Loading gateways" />
              ) : (
                <ul className="flex flex-col">
                  {ALL_GATEWAYS.map((p) => {
                    const a = byProvider(gateways.data)[p];
                    const st = integrationStatusMeta(a?.status ?? 'not_connected');
                    return (
                      <li key={p} className="flex items-center gap-3.5 py-3">
                        <GatewayLogo provider={p} size="md" />
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="flex items-center gap-2 text-body font-semibold text-text-primary">
                            {gatewayMeta[p].name}
                            {a?.is_default && isConnected(a) && <Badge tone="brand">Default</Badge>}
                          </span>
                          <span className="truncate text-caption text-text-secondary">{isConnected(a) && a?.mode ? `${modeLabel[a.mode]} · ${gatewayMeta[p].capability}` : gatewayMeta[p].capability}</span>
                        </span>
                        <Badge tone={st.tone} dot>
                          {st.label}
                        </Badge>
                      </li>
                    );
                  })}
                </ul>
              )}
            </SettingsCard>
          </>
        );
      }}
    </Gate>
  );
}

function TitleWithBadge({ title, badge }: { title: string; badge: ReactNode }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      {title}
      {badge}
    </span>
  );
}

const SMS_EVENTS: { key: CustomerSmsEvent; title: string; hint: string; status: OrderStatus }[] = [
  { key: 'order_placed', title: 'Order received', hint: 'Sent right after the order is placed', status: 'pending' },
  { key: 'order_confirmed', title: 'Order confirmed', hint: 'Sent when you confirm the order', status: 'confirmed' },
  { key: 'order_shipped', title: 'Shipped with tracking', hint: 'Sent when the courier picks up the parcel', status: 'shipped' },
  { key: 'order_cancelled', title: 'Order cancelled', hint: 'Sent when an order is cancelled', status: 'cancelled' },
];

/**
 * Notifications 60:15863: "Alerts for you" (new-order email only; the in-app/push/SMS matrix is not built) and
 * "Customer messages" in the Figma two-column layout: SMS tab, status list (330 px) with per-event toggles, and the
 * selected event's language chips + phone preview. PHASE-8-9A §12.6: the preview is the server's template preview
 * (`sms.templates.list`, custom texts included) with an "Edit text" link to Integrations › SMS › Templates; the client
 * `smsPreview` is only the fallback for members without template read access (or while it loads).
 */
export function NotificationsSettingsPage() {
  const { canManageSettings, store } = useStoreScope();
  const { activeTenant } = useAuth();
  const templatesAllowed = canOpenSms(activeTenant);
  const templates = useSmsTemplates({ enabled: templatesAllowed });
  const save = useSaveSettings('Notification settings saved.');
  const [previewEvent, setPreviewEvent] = useState<CustomerSmsEvent>('order_placed');
  return (
    <Gate>
      {(s) => {
        const n = s.commerce.notifications;
        const shop = store?.name ?? s.identity.name;
        const current = SMS_EVENTS.find((e) => e.key === previewEvent) ?? SMS_EVENTS[0]!;
        const onCount = SMS_EVENTS.filter((e) => n.customer_sms[e.key]).length;
        return (
          <>
            <Heading title="Notifications" subtitle="Alerts for you, and the messages customers receive at each step of their order." />
            <ReadOnlyNote show={!canManageSettings} />
            <SettingsCard title="Alerts for you" description={`Sent to ${s.contact.email ?? 'the shop owner’s email'}.`}>
              <ToggleRow icon={<Mail />} tint="brand" title="New order" hint="An email for every new order, with a link to it">
                <Toggle label="New order email" checked={n.new_order_email} disabled={!canManageSettings || save.isPending} onChange={(on) => save.mutate({ notifications: { new_order_email: on } })} />
              </ToggleRow>
            </SettingsCard>
            <SettingsCard title="Customer messages" description="Automatic SMS at each order status. Bangla messages get more replies and fewer returns.">
              <div role="tablist" aria-label="Message channel" className="flex gap-1 border-b border-border-default">
                <span role="tab" aria-selected className="flex items-center gap-1.5 border-b-2 border-brand-600 px-3 pt-2.5 pb-2 text-body font-semibold text-brand-700">
                  SMS
                  <span className="rounded-full bg-brand-600 px-[7px] py-px text-caption font-medium text-text-inverse">{onCount}</span>
                </span>
              </div>
              <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
                <ul aria-label="SMS by order status" className="flex flex-col gap-2 lg:w-[330px] lg:shrink-0">
                  {SMS_EVENTS.map((e) => {
                    const on = n.customer_sms[e.key];
                    const selected = e.key === previewEvent;
                    return (
                      <li key={e.key} className={cn('flex items-center gap-2.5 rounded-lg border px-3 py-2.5', selected ? 'border-brand-100 bg-brand-50' : 'border-border-default')}>
                        <OrderStatusBadge status={e.status} />
                        <button
                          type="button"
                          aria-pressed={selected}
                          className={cn('min-w-0 flex-1 text-left text-body outline-none focus-visible:underline', selected ? 'font-semibold' : 'font-normal', on ? 'text-text-primary' : 'text-text-muted')}
                          onClick={() => setPreviewEvent(e.key)}
                        >
                          {e.title}
                        </button>
                        <Toggle
                          label={`SMS: ${e.title}`}
                          checked={on}
                          disabled={!canManageSettings || save.isPending}
                          onChange={(v) => save.mutate({ notifications: { customer_sms: { [e.key]: v } } })}
                        />
                      </li>
                    );
                  })}
                </ul>
                <div className="flex min-w-0 flex-1 flex-col gap-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-body font-semibold text-text-primary">{orderStatusMeta[current.status].label} · SMS</span>
                      <span className="text-caption text-text-secondary">{current.hint}</span>
                    </div>
                    <div role="group" aria-label="SMS language" className="flex gap-2">
                      {(
                        [
                          ['bn', 'বাংলা'],
                          ['en', 'English'],
                        ] as const
                      ).map(([value, label]) => (
                        <Chip
                          key={value}
                          selected={n.sms_language === value}
                          disabled={!canManageSettings || save.isPending}
                          className={value === 'bn' ? 'font-bangla' : undefined}
                          onClick={() => n.sms_language !== value && save.mutate({ notifications: { sms_language: value } })}
                        >
                          {label}
                        </Chip>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-col gap-2.5 rounded-card bg-surface-subtle p-4">
                    <div className="flex items-center gap-2.5">
                      <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-600 text-caption font-medium text-text-inverse">
                        {shop.trim().charAt(0).toUpperCase() || 'S'}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-body font-semibold text-text-primary">{shop}</span>
                        <span className="text-caption text-text-muted">Preview · {current.title}</span>
                      </span>
                    </div>
                    <p
                      className={cn('rounded-t-card rounded-br-card rounded-bl-[4px] bg-surface-card px-3.5 py-3 text-body-lg text-text-primary', n.sms_language === 'bn' && 'font-bangla leading-[26px]')}
                      data-testid="sms-preview"
                    >
                      {templates.data?.find((t) => t.key === previewEvent && t.language === n.sms_language)?.preview.text ?? smsPreview(previewEvent, n.sms_language, shop)}
                    </p>
                    {templatesAllowed && (
                      <Link to={`/integrations/sms?tab=templates&key=${previewEvent}`} className="self-start text-body font-medium text-brand-600 hover:underline">
                        Edit text
                      </Link>
                    )}
                  </div>
                </div>
              </div>
            </SettingsCard>
          </>
        );
      }}
    </Gate>
  );
}

/** Taxes & invoices 60:16858: prefix (5a) + VAT display, BIN and invoice footer (5b P5B-56). VAT on top is deferred (Q52). */
export function InvoicesSettingsPage() {
  return <Gate>{(s) => <InvoicesForm key={s.updated_at} settings={s} />}</Gate>;
}

function InvoicesForm({ settings }: { settings: StoreSettings }) {
  const { canManageSettings } = useStoreScope();
  const save = useSaveSettings('Order numbering saved.');
  const [prefix, setPrefix] = useState(settings.commerce.order_prefix);
  const valid = /^[A-Z]{1,6}$/.test(prefix);
  const seq = settings.commerce.next_order_number.split('-').pop() ?? '1001';
  return (
    <>
      <Heading title="Taxes & invoices" subtitle="Invoice numbers, VAT details and what prints at the bottom of every invoice." />
      <ReadOnlyNote show={!canManageSettings} />
      <SettingsCard
        title="Invoice numbering"
        description="Order numbers and invoice numbers stay in sync, so customers and couriers quote one number."
      >
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <Input
            id="order-prefix"
            label="Invoice prefix"
            hint="Applies to new orders only."
            value={prefix}
            maxLength={6}
            disabled={!canManageSettings}
            error={valid ? undefined : 'Use 1–6 letters A–Z.'}
            onChange={(e) => setPrefix(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
          />
          <Input id="next-number" label="Next number" value={seq} readOnly disabled />
        </div>
        <p className="flex items-center gap-2.5 rounded-lg bg-brand-50 px-4 py-3 text-body text-text-secondary" aria-live="polite">
          <ReceiptText aria-hidden className="size-[18px] shrink-0 text-brand-600" />
          Next invoice will be <strong className="font-semibold text-brand-600">{valid ? `${prefix}-${seq}` : settings.commerce.next_order_number}</strong>
        </p>
        {canManageSettings && (
          <Button className="self-start" disabled={!valid || prefix === settings.commerce.order_prefix} loading={save.isPending} onClick={() => save.mutate({ order_prefix: prefix })}>
            Save
          </Button>
        )}
      </SettingsCard>
      <VatCard settings={settings} disabled={!canManageSettings} />
      <FooterCard settings={settings} disabled={!canManageSettings} />
      <p className="flex items-center gap-2.5 rounded-lg bg-surface-subtle px-4 py-3 text-body text-text-secondary">
        <LifeBuoy aria-hidden className="size-[18px] shrink-0" />
        <span className="min-w-0 flex-1">Return, refund, privacy and terms pages moved to Policies & legal pages.</span>
        <Link to="/settings/policies" className="shrink-0 font-medium text-brand-600 hover:underline">
          Open →
        </Link>
      </p>
    </>
  );
}

// `UpdateStoreSettingsInput` in @storeplix/types doesn't list `tax` / `invoice` yet; openapi 1.6.0 does.
type TaxSettingsInput = UpdateStoreSettingsInput & {
  tax?: { display?: 'none' | 'included'; rate_bps?: number; bin?: string | null };
  invoice?: { footer?: string | null };
};

const BIN_RE = /^[0-9]{9}(-[0-9]{4})?$/;

function VatCard({ settings, disabled }: { settings: StoreSettings; disabled: boolean }) {
  const save = useSaveSettings('VAT settings saved.');
  const tax = settings.commerce.tax ?? { display: 'none', rate_bps: 0, bin: null };
  const [on, setOn] = useState(tax.display === 'included');
  const [rate, setRate] = useState(tax.rate_bps ? String(tax.rate_bps / 100) : '5');
  const [bin, setBin] = useState(tax.bin ?? '');
  const rateBps = Math.round(Number(rate) * 100);
  const rateOk = /^\d{1,2}(\.\d{1,2})?$/.test(rate.trim()) && rateBps >= 0 && rateBps <= 2500;
  const binOk = !bin.trim() || BIN_RE.test(bin.trim());
  const dirty = on !== (tax.display === 'included') || (on && (rateBps !== tax.rate_bps || (bin.trim() || null) !== tax.bin)) || (!on && (bin.trim() || null) !== tax.bin);
  const sample = 225_000;
  return (
    <SettingsCard title="VAT" badge={<Badge>Optional</Badge>} description="Only needed if your business is VAT-registered with NBR.">
      <SettingsToggleRow title="Show VAT on invoices" description="Adds your BIN and a “Prices include VAT” line to every invoice.">
        <Toggle label="Show VAT on invoices" checked={on} disabled={disabled} onChange={setOn} />
      </SettingsToggleRow>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input id="vat-bin" label="BIN (Business Identification Number)" placeholder="004567891-0101" value={bin} maxLength={14} disabled={disabled} error={binOk ? undefined : 'Use 9 digits, or 9 digits, a dash and 4 digits.'} onChange={(e) => setBin(e.target.value)} />
        {on && <Input id="vat-rate" label="VAT rate (%)" inputMode="decimal" value={rate} disabled={disabled} error={rateOk ? undefined : 'Enter a rate from 0 to 25 %.'} onChange={(e) => setRate(e.target.value)} />}
      </div>
      {on && rateOk && (
        <p className="rounded-md bg-surface-subtle px-3.5 py-2.5 text-body text-text-secondary">
          Prices already include VAT. Example: a ৳ 2,250 order shows “includes VAT ৳ {(vatIncluded(sample, rateBps) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}” on the invoice. Order totals don’t change.
        </p>
      )}
      {!disabled && (
        <Button
          className="self-start"
          disabled={!dirty || !binOk || (on && !rateOk)}
          loading={save.isPending}
          onClick={() => save.mutate({ tax: on ? { display: 'included', rate_bps: rateBps, bin: bin.trim() || null } : { display: 'none', bin: bin.trim() || null } } as TaxSettingsInput)}
        >
          Save VAT
        </Button>
      )}
    </SettingsCard>
  );
}

function FooterCard({ settings, disabled }: { settings: StoreSettings; disabled: boolean }) {
  const save = useSaveSettings('Invoice footer saved.');
  const initial = settings.commerce.invoice?.footer ?? '';
  const [footer, setFooter] = useState(initial);
  return (
    <SettingsCard
      title="Invoice footer"
      description="Printed at the bottom of A4 and 80 mm invoices. Bangla works."
      action={
        <Link to="/orders/print" className="inline-flex min-h-8 items-center rounded-md px-3 py-1 text-caption font-medium text-brand-600 hover:bg-brand-50">
          Edit invoice layout ↗
        </Link>
      }
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="invoice-footer" className="text-body font-medium text-text-primary">
          Footer note
        </label>
        <textarea
          id="invoice-footer"
          rows={2}
          maxLength={300}
          disabled={disabled}
          value={footer}
          placeholder="ধন্যবাদ! পণ্য হাতে পেয়ে চেক করে নিন।"
          onChange={(e) => setFooter(e.target.value)}
          className="rounded-md border border-border-default bg-surface-card px-3.5 py-3 font-bangla text-body-lg text-text-primary outline-none placeholder:text-text-muted focus:border-brand-600 disabled:bg-surface-subtle"
        />
        <span className="text-caption text-text-muted">{footer.length}/300</span>
      </div>
      {!disabled && (
        <Button className="self-start" disabled={footer === initial} loading={save.isPending} onClick={() => save.mutate({ invoice: { footer: footer.trim() || null } } as TaxSettingsInput)}>
          Save footer
        </Button>
      )}
    </SettingsCard>
  );
}
