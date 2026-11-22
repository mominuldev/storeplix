import type { CustomerSmsEvent, StoreSettings, UpdateStoreSettingsInput } from '@storeplix/types';
import { isApiError } from '@storeplix/api-client';
import type { PaymentGatewayAccount } from '@storeplix/types';
import { Badge, Button, buttonVariants, cn, Input, ProviderLogo, SegmentedControl, Spinner, Toggle } from '@storeplix/ui';
import { useMutation } from '@tanstack/react-query';
import { ArrowUpRight, Mail, ShieldCheck, Truck, Wallet } from 'lucide-react';
import { Link } from 'react-router';
import { useState, type ReactNode } from 'react';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, errorMessage } from '../catalog/states';
import { api } from '../lib/api';
import { toast } from '../online-store/components/Toast';
import { byProvider, GATEWAYS, gatewayMeta, integrationStatusMeta, isConnected, isUsable, modeLabel } from '../payments/gateways';
import { usePaymentGateways, usePaymentInvalidate } from '../payments/queries';
import { FormAlert } from '../onboarding/AuthShell';
import { smsPreview, useSaveSettings, useStoreSettings, vatIncluded } from './commerceSettings';
import { SettingsCard } from './SettingsLayout';

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

function ToggleRow({ icon, title, hint, children, disabled }: { icon?: ReactNode; title: ReactNode; hint?: ReactNode; children: ReactNode; disabled?: boolean }) {
  return (
    <div className={cn('flex items-center gap-4 rounded-lg border border-border-default p-4', disabled && 'opacity-60')}>
      {icon && <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-surface-subtle text-text-secondary [&_svg]:size-5">{icon}</span>}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-body font-semibold text-text-primary">{title}</span>
        {hint && <span className="text-caption text-text-muted">{hint}</span>}
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
            <SettingsCard title="Checkout payment methods" description="Customers choose one of these at checkout. Turn on at least one.">
              <ToggleRow icon={<Truck />} title={<TitleWithBadge title="Cash on delivery" badge={<Badge>Most used</Badge>} />} hint="The rider collects cash. Your courier sends the money to you after delivery.">
                <Toggle
                  label="Cash on delivery"
                  checked={s.commerce.checkout.cod_enabled}
                  disabled={!canManageSettings || save.isPending}
                  onChange={(on) => save.mutate({ checkout: { cod_enabled: on } })}
                />
              </ToggleRow>
              {!s.commerce.checkout.cod_enabled && usable.length === 0 && <FormAlert>With cash on delivery off and no gateway on, customers can’t place orders.</FormAlert>}
              <ToggleRow
                icon={<Wallet />}
                title={<TitleWithBadge title="Advance delivery charge" badge={<Badge tone="success">Recommended</Badge>} />}
                hint={usable.length ? 'Customers pay only the delivery charge online before you ship. Cuts fake orders.' : 'Connect bKash or SSLCommerz and turn it on at checkout first.'}
                disabled={!usable.length && !advance}
              >
                <Toggle
                  label="Advance delivery charge"
                  checked={advance}
                  disabled={!canManageSettings || save.isPending || (!usable.length && !advance)}
                  onChange={(on) => save.mutate({ checkout: { cod_advance: on ? 'delivery_charge' : 'none' } })}
                />
              </ToggleRow>
              <div className="flex flex-col gap-3 rounded-lg border border-border-default p-4">
                <div className="flex items-center gap-4">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-surface-subtle text-text-secondary [&_svg]:size-5">
                    <ShieldCheck />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-body font-semibold text-text-primary">Full online payment</span>
                    <span className="text-caption text-text-muted">Customers pay the full amount with bKash, Nagad, card or net banking through your gateway.</span>
                  </span>
                </div>
                {gateways.isPending ? (
                  <Spinner label="Loading gateways" />
                ) : gateways.isError ? (
                  <ErrorBlock title="We couldn’t load your gateways" error={gateways.error} onRetry={() => void gateways.refetch()} />
                ) : connected.length === 0 ? (
                  <p className="text-caption text-text-muted">
                    No gateway connected yet.{' '}
                    <Link to="/integrations" className="font-medium text-brand-600">
                      Connect one in Integrations
                    </Link>
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {connected.map((a) => (
                      <li key={a.provider} className="flex items-center gap-3 rounded-md bg-surface-subtle px-3 py-2">
                        <ProviderLogo provider={a.provider} size="sm" />
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
              <p className="flex items-start gap-2.5 rounded-lg bg-info-bg px-4 py-3 text-caption text-text-primary">
                <ShieldCheck aria-hidden className="size-4 shrink-0 text-info" /> Paid orders move to Confirmed on their own when the gateway confirms the payment. Failed or cancelled payments stay Unpaid.
              </p>
            </SettingsCard>
            <SettingsCard title="Connected gateways" description="Online payments go straight to your gateway account. Settlement follows each gateway’s schedule.">
              <div className="-mt-2 flex justify-end">
                <Link to="/integrations" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
                  Manage in Integrations <ArrowUpRight aria-hidden className="size-4" />
                </Link>
              </div>
              {gateways.isPending ? (
                <Spinner label="Loading gateways" />
              ) : (
                <ul className="flex flex-col divide-y divide-border-default">
                  {GATEWAYS.map((p) => {
                    const a = byProvider(gateways.data)[p];
                    const st = integrationStatusMeta(a?.status ?? 'not_connected');
                    return (
                      <li key={p} className="flex items-center gap-3 py-3">
                        <ProviderLogo provider={p} size="sm" />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="flex items-center gap-2 text-body font-semibold text-text-primary">
                            {gatewayMeta[p].name}
                            {a?.is_default && isConnected(a) && <Badge tone="brand">Default</Badge>}
                          </span>
                          <span className="truncate text-caption text-text-muted">{isConnected(a) && a?.mode ? `${modeLabel[a.mode]} · ${gatewayMeta[p].capability}` : gatewayMeta[p].capability}</span>
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

const SMS_EVENTS: { key: CustomerSmsEvent; title: string; hint: string }[] = [
  { key: 'order_placed', title: 'Order received', hint: 'Right after the order is placed' },
  { key: 'order_confirmed', title: 'Order confirmed', hint: 'When you confirm it' },
  { key: 'order_shipped', title: 'Shipped with tracking', hint: 'With the courier name and amount to keep ready' },
  { key: 'order_cancelled', title: 'Order cancelled', hint: 'When an order is cancelled' },
];

/** Notifications 60:15863: New order email toggle; customer SMS toggles, language, read-only preview. */
export function NotificationsSettingsPage() {
  const { canManageSettings, store } = useStoreScope();
  const save = useSaveSettings('Notification settings saved.');
  const [previewEvent, setPreviewEvent] = useState<CustomerSmsEvent>('order_placed');
  return (
    <Gate>
      {(s) => {
        const n = s.commerce.notifications;
        return (
          <>
            <Heading title="Notifications" subtitle="What you and your customers hear about orders." />
            <ReadOnlyNote show={!canManageSettings} />
            <SettingsCard title="Alerts for you" description={`Sent to ${s.contact.email ?? 'the shop owner’s email'}.`}>
              <ToggleRow icon={<Mail />} title="New order" hint="An email for every new order, with a link to it">
                <Toggle label="New order email" checked={n.new_order_email} disabled={!canManageSettings || save.isPending} onChange={(on) => save.mutate({ notifications: { new_order_email: on } })} />
              </ToggleRow>
            </SettingsCard>
            <SettingsCard title="Customer messages" description="SMS to the buyer’s phone. Templates are fixed for now.">
              <div className="flex items-center justify-between gap-3">
                <span className="text-body font-medium text-text-primary">Language</span>
                <SegmentedControl
                  aria-label="SMS language"
                  size="sm"
                  value={n.sms_language}
                  disabled={!canManageSettings || save.isPending}
                  onChange={(v) => save.mutate({ notifications: { sms_language: v } })}
                  options={[
                    { value: 'bn', label: 'বাংলা' },
                    { value: 'en', label: 'English' },
                  ]}
                />
              </div>
              <ul className="flex flex-col gap-2">
                {SMS_EVENTS.map((e) => (
                  <li key={e.key}>
                    <ToggleRow
                      title={
                        <button type="button" className="text-left hover:text-brand-600" onClick={() => setPreviewEvent(e.key)}>
                          {e.title}
                        </button>
                      }
                      hint={e.hint}
                    >
                      <Toggle
                        label={`SMS: ${e.title}`}
                        checked={n.customer_sms[e.key]}
                        disabled={!canManageSettings || save.isPending}
                        onChange={(on) => save.mutate({ notifications: { customer_sms: { [e.key]: on } } })}
                      />
                    </ToggleRow>
                  </li>
                ))}
              </ul>
              <div className="flex flex-col gap-2 rounded-lg bg-surface-subtle p-4">
                <span className="text-caption font-medium text-text-muted">Preview · {SMS_EVENTS.find((e) => e.key === previewEvent)?.title}</span>
                <p className={cn('rounded-lg bg-surface-card p-3 text-body text-text-primary shadow-elevation-1', n.sms_language === 'bn' && 'font-bangla')} data-testid="sms-preview">
                  {smsPreview(previewEvent, n.sms_language, store?.name ?? s.identity.name)}
                </p>
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
      <Heading title="Taxes & invoices" subtitle="Order numbers your customers and couriers see." />
      <ReadOnlyNote show={!canManageSettings} />
      <SettingsCard title="Invoice numbering" description="A changed prefix applies to new orders only.">
        <div className="flex flex-wrap items-end gap-3">
          <Input
            id="order-prefix"
            label="Prefix"
            value={prefix}
            maxLength={6}
            disabled={!canManageSettings}
            error={valid ? undefined : 'Use 1–6 letters A–Z.'}
            containerClassName="w-40"
            onChange={(e) => setPrefix(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
          />
          {canManageSettings && (
            <Button disabled={!valid || prefix === settings.commerce.order_prefix} loading={save.isPending} onClick={() => save.mutate({ order_prefix: prefix })}>
              Save
            </Button>
          )}
        </div>
        <p className="text-body text-text-secondary" aria-live="polite">
          Next invoice will be <strong className="text-text-primary">{valid ? `${prefix}-${seq}` : settings.commerce.next_order_number}</strong>
        </p>
      </SettingsCard>
      <VatCard settings={settings} disabled={!canManageSettings} />
      <FooterCard settings={settings} disabled={!canManageSettings} />
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
    <SettingsCard title="VAT" description="Only needed if your business is VAT-registered with NBR.">
      <ToggleRow title="Show VAT on invoices" hint="Adds your BIN and a “Prices include VAT” line to every invoice." disabled={disabled}>
        <Toggle label="Show VAT on invoices" checked={on} disabled={disabled} onChange={setOn} />
      </ToggleRow>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input id="vat-bin" label="BIN (Business Identification Number)" placeholder="004567891-0101" value={bin} maxLength={14} disabled={disabled} error={binOk ? undefined : 'Use 9 digits, or 9 digits, a dash and 4 digits.'} onChange={(e) => setBin(e.target.value)} />
        {on && <Input id="vat-rate" label="VAT rate (%)" inputMode="decimal" value={rate} disabled={disabled} error={rateOk ? undefined : 'Enter a rate from 0 to 25 %.'} onChange={(e) => setRate(e.target.value)} />}
      </div>
      {on && rateOk && (
        <p className="rounded-md bg-surface-subtle px-3 py-2 text-body text-text-secondary">
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
    <SettingsCard title="Invoice footer" description="Printed at the bottom of A4 and 80 mm invoices. Bangla works.">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="invoice-footer" className="text-body font-medium text-text-primary">
          Footer note
        </label>
        <textarea
          id="invoice-footer"
          rows={3}
          maxLength={300}
          disabled={disabled}
          value={footer}
          placeholder="ধন্যবাদ! পণ্য হাতে পেয়ে চেক করে নিন।"
          onChange={(e) => setFooter(e.target.value)}
          className="rounded-md border border-border-default px-3 py-2 text-body outline-none focus:border-brand-600 disabled:bg-surface-subtle"
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
