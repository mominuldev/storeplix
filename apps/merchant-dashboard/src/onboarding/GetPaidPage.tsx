import { isApiError } from '@storeplix/api-client';
import type { GatewayProvider, LaunchItemKey } from '@storeplix/types';
import { Badge, Button, cn, Toggle } from '@storeplix/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronRight, ShieldCheck, ShoppingCart } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, errorMessage } from '../catalog/states';
import { useCommerceInvalidate } from '../commerce/queries';
import { api } from '../lib/api';
import { LoadingState } from '../online-store/components/Shell';
import { ConnectGatewayDialog } from '../payments/ConnectGatewayDialog';
import { ALL_GATEWAYS, byProvider, GATEWAYS, gatewayMeta, isConnected, isUsable } from '../payments/gateways';
import { usePaymentGateways } from '../payments/queries';
import { useStoreSettings } from '../settings/commerceSettings';
import { settingsKey } from '../settings/schema';
import { storeKey } from '../stores/useTenantStore';
import { FormAlert } from './AuthShell';
import { blockerLinks } from './launch';
import { OnboardingCard, OnboardingFrame, PreviewOption, previewCardClass } from './OnboardingFrame';
import { GatewayLogo } from '../payments/GatewayLogo';

// Figma Merchant Onboarding · 07 Get paid 52:564. COD card with toggle (`checkout.cod_enabled`); 5b-2: "Collect
// delivery charge in advance" (`checkout.cod_advance`) once a gateway is connected and on at checkout; bKash and
// SSLCommerz Connect open the gateway wizard (32:3770); the checkout preview lists the connected methods. EPS hidden
// (§10). Finish setup saves the toggles → POST /publish; 409 `launch_blocked` → inline blockers; success → /onboarding/live.

export function GetPaidPage() {
  const { store } = useStoreScope();
  const settings = useStoreSettings();
  if (!store || settings.isPending) return <LoadingState label="Loading" />;
  return <GetPaidForm initialCod={settings.data?.commerce?.checkout.cod_enabled ?? true} initialAdvance={settings.data?.commerce?.checkout.cod_advance === 'delivery_charge'} />;
}

function GetPaidForm({ initialCod, initialAdvance }: { initialCod: boolean; initialAdvance: boolean }) {
  const navigate = useNavigate();
  const scope = useStoreScope();
  const { tenantId } = useAuth();
  const qc = useQueryClient();
  const invalidate = useCommerceInvalidate();
  const editable = scope.canManageSettings;
  const [cod, setCod] = useState(initialCod);
  const [advance, setAdvance] = useState(initialAdvance);
  const [connecting, setConnecting] = useState<GatewayProvider | null>(null);
  const gateways = usePaymentGateways();
  const accounts = byProvider(gateways.data);
  const usable = ALL_GATEWAYS.filter((p) => isUsable(accounts[p]));
  const canConnect = scope.canManageIntegrations;
  const [blockers, setBlockers] = useState<{ key: LaunchItemKey; message: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const finish = useMutation({
    mutationFn: async () => {
      const advanceOn = advance && usable.length > 0;
      if (cod !== initialCod || advanceOn !== initialAdvance) {
        const s = await api.stores.updateSettings(scope.storeId!, { checkout: { cod_enabled: cod, cod_advance: advanceOn ? 'delivery_charge' : 'none' } });
        qc.setQueryData(settingsKey(scope.storeId ?? undefined), s);
      }
      return api.launch.publish(scope.storeId!);
    },
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: storeKey(tenantId) }), invalidate.launch()]);
      navigate('/onboarding/live');
    },
    onError: (e) => {
      if (isApiError(e) && e.code === 'launch_blocked') {
        setError(null);
        return setBlockers(Object.entries(e.fieldErrors ?? {}).map(([key, m]) => ({ key: key as LaunchItemKey, message: m[0] ?? '' })));
      }
      setBlockers([]);
      setError(errorMessage(e, 'We couldn’t publish your shop. Try again.'));
    },
  });

  return (
    <OnboardingFrame
      step={7}
      shopName={scope.store!.name}
      title="How you’ll get paid"
      subtitle={cod ? 'Cash on delivery is on. Add a payment gateway when you’re ready for advance or full online payments.' : 'Choose how customers pay. Most shoppers in Bangladesh pay cash on delivery.'}
      bangla="টাকা সরাসরি আপনার অ্যাকাউন্টে যায়"
      back="/onboarding/delivery"
      footer={
        editable ? (
          <Button loading={finish.isPending} onClick={() => finish.mutate()}>
            Finish setup
          </Button>
        ) : (
          <Button onClick={() => navigate('/')}>Go to dashboard</Button>
        )
      }
      aside={
        <section aria-label="Payment preview" className={cn(previewCardClass, 'gap-3.5')}>
          <span className="text-body-lg font-medium text-text-primary">Payment method</span>
          {cod && (
            <PreviewOption
              selected
              title="Cash on delivery"
              hint={advance && usable.length ? 'Pay the delivery charge now, the rest when it arrives' : 'Pay when the parcel arrives'}
            />
          )}
          {usable.map((p) => (
            <PreviewOption key={p} selected={false} title={gatewayMeta[p].checkoutLabel} hint={gatewayMeta[p].checkoutHint} trailing={<GatewayLogo provider={p} size="sm" />} />
          ))}
          {!cod && usable.length === 0 && <p className="text-caption text-danger">Turn on cash on delivery or connect a gateway so customers can pay.</p>}
          {usable.length === 0 && cod && <p className="text-caption text-text-muted">Connected gateways show here too.</p>}
          <span aria-hidden className="h-px bg-border-default" />
          <p className="flex items-center gap-1.5 text-caption text-text-muted">
            <ShieldCheck aria-hidden className="size-3.5" /> Paid directly to {scope.store?.name}
          </p>
        </section>
      }
    >
      {error && <FormAlert>{error}</FormAlert>}
      {blockers.length > 0 && (
        <section role="alert" aria-label="Before you go live" className="flex flex-col gap-3 rounded-card border border-warning bg-warning-bg p-4">
          <p className="flex items-center gap-2 text-body font-semibold text-text-primary">
            <AlertTriangle aria-hidden className="size-4 text-warning" /> A few things before you go live
          </p>
          <ul className="flex flex-col gap-2">
            {blockers.map((b) => (
              <li key={b.key}>
                <Link to={blockerLinks[b.key]?.to ?? '/'} className="flex items-center gap-2 rounded-md bg-surface-card px-3 py-2 text-body hover:bg-surface-subtle">
                  <span className="flex-1 text-text-primary">{b.message || blockerLinks[b.key]?.label}</span>
                  <span className="text-caption font-medium text-brand-600">{blockerLinks[b.key]?.label}</span>
                  <ChevronRight aria-hidden className="size-4 text-text-muted" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Figma 52:662: COD row (48 success tile, badge, toggle) · divider · advance row. */}
      <section aria-label="Cash on delivery" className="flex flex-col gap-5 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1 lg:p-6">
        <div className="flex items-center gap-3.5">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-success-bg text-success">
            <ShoppingCart aria-hidden className="size-6" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-body-lg font-medium text-text-primary">Cash on delivery</span>
              {cod && <span className="rounded-full bg-success-bg px-2 py-0.5 text-caption font-medium text-success">On · Recommended</span>}
            </span>
            <span className="text-body text-text-secondary">Customers pay the courier when the parcel arrives. 9 in 10 shoppers in Bangladesh choose this.</span>
          </span>
          <Toggle label="Accept cash on delivery" checked={cod} disabled={!editable} onChange={setCod} />
        </div>
        <span aria-hidden className="h-px bg-border-default" />
        <div className={cn('flex items-center gap-3.5', !usable.length && 'opacity-60')}>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-body font-medium text-text-primary">Collect delivery charge in advance</span>
            <span className="text-caption text-text-muted">{usable.length ? 'Cuts fake orders. Customers pay the delivery charge online first.' : 'Cuts fake orders. Needs a payment gateway below.'}</span>
          </span>
          <Toggle label="Collect delivery charge in advance" checked={advance && usable.length > 0} disabled={!editable || !usable.length} onChange={setAdvance} />
        </div>
      </section>

      <OnboardingCard title="Online & advance payments" description="Let customers pay in full or pay the delivery charge upfront.">
        {gateways.isError ? (
          <ErrorBlock title="We couldn’t load payment gateways" error={gateways.error} onRetry={() => void gateways.refetch()} />
        ) : (
          <ul className="flex flex-col gap-5">
            {GATEWAYS.map((p) => {
              const a = accounts[p];
              const connected = isConnected(a);
              return (
                <li key={p} className="flex items-center gap-3.5 rounded-lg border border-border-default bg-surface-card p-4">
                  <GatewayLogo provider={p} size="lg" className="rounded-control" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2 text-body font-semibold text-text-primary">
                      {gatewayMeta[p].name}
                      {connected && (
                        <Badge tone="success" dot>
                          Connected
                        </Badge>
                      )}
                    </span>
                    <span className="text-caption text-text-secondary">{gatewayMeta[p].onboardingHint}</span>
                  </span>
                  {canConnect && (
                    <Button size="sm" variant="secondary" disabled={gateways.isPending} onClick={() => setConnecting(p)} aria-label={`${connected ? 'Manage' : 'Connect'} ${gatewayMeta[p].name}`}>
                      {connected ? 'Manage' : 'Connect'}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-caption text-text-muted">Not ready? Start with cash on delivery and connect a gateway anytime.</p>
      </OnboardingCard>

      {/* Figma 52:719 money note. */}
      <div className="flex items-start gap-3 rounded-lg bg-success-bg p-4">
        <ShieldCheck aria-hidden className="size-[22px] shrink-0 text-success" />
        <span className="flex flex-col gap-1">
          <span className="text-body font-semibold text-text-primary">Money goes straight to your account — Storeplix never holds it.</span>
          <span className="text-caption text-text-secondary">COD is paid out by your courier. Online payments settle from the gateway to your own bKash merchant or bank account.</span>
        </span>
      </div>
      {connecting && <ConnectGatewayDialog provider={connecting} account={accounts[connecting]} onClose={() => setConnecting(null)} />}
    </OnboardingFrame>
  );
}

export default GetPaidPage;
