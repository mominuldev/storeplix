import { isApiError } from '@storeplix/api-client';
import type { GatewayProvider, LaunchItemKey } from '@storeplix/types';
import { Badge, Button, cn, ProviderLogo, Toggle } from '@storeplix/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Banknote, ChevronRight, ShieldCheck, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock, errorMessage } from '../catalog/states';
import { useCommerceInvalidate } from '../commerce/queries';
import { api } from '../lib/api';
import { LoadingState } from '../online-store/components/Shell';
import { ConnectGatewayDialog } from '../payments/ConnectGatewayDialog';
import { byProvider, GATEWAYS, gatewayMeta, isConnected, isUsable } from '../payments/gateways';
import { usePaymentGateways } from '../payments/queries';
import { useStoreSettings } from '../settings/commerceSettings';
import { settingsKey } from '../settings/schema';
import { storeKey } from '../stores/useTenantStore';
import { FormAlert } from './AuthShell';
import { blockerLinks } from './launch';
import { OnboardingCard, OnboardingFrame } from './OnboardingFrame';

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
  const usable = GATEWAYS.filter((p) => isUsable(accounts[p]));
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
        return setBlockers(Object.entries(e.details ?? {}).map(([key, m]) => ({ key: key as LaunchItemKey, message: m[0] ?? '' })));
      }
      setBlockers([]);
      setError(errorMessage(e, 'We couldn’t publish your shop. Try again.'));
    },
  });

  return (
    <OnboardingFrame
      step={7}
      shopName={scope.store!.name}
      title="Get paid"
      subtitle="Choose how customers pay. Most shoppers in Bangladesh pay cash on delivery."
      bangla="ক্যাশ অন ডেলিভারি দিয়েই আজ বিক্রি শুরু করুন"
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
        <section aria-label="Payment preview" className="flex flex-col gap-3 rounded-card bg-surface-card p-4 shadow-elevation-1">
          <span className="text-body-lg font-semibold text-text-primary">Payment method</span>
          {cod && (
            <div className="flex items-center gap-3 rounded-lg border border-brand-600 bg-brand-50 p-3">
              <span aria-hidden className="flex size-4 items-center justify-center rounded-full border-2 border-brand-600">
                <span className="size-2 rounded-full bg-brand-600" />
              </span>
              <span className="flex flex-col">
                <span className="text-body font-medium text-text-primary">Cash on delivery</span>
                <span className="text-caption text-text-muted">{advance && usable.length ? 'Pay the delivery charge now, the rest when it arrives' : 'Pay when the parcel arrives'}</span>
              </span>
            </div>
          )}
          {usable.map((p) => (
            <div key={p} className="flex items-center gap-3 rounded-lg border border-border-default p-3">
              <span aria-hidden className="size-4 rounded-full border-2 border-border-strong" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-body font-medium text-text-primary">{gatewayMeta[p].checkoutLabel}</span>
                <span className="text-caption text-text-muted">{gatewayMeta[p].checkoutHint}</span>
              </span>
              <ProviderLogo provider={p} size="sm" />
            </div>
          ))}
          {!cod && usable.length === 0 && <p className="text-caption text-danger">Turn on cash on delivery or connect a gateway so customers can pay.</p>}
          {usable.length === 0 && cod && <p className="text-caption text-text-muted">Connected gateways show here too.</p>}
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

      <OnboardingCard title="Cash on delivery" description="9 in 10 shoppers choose this. The courier or you collect the money at the door.">
        <div className="flex items-center gap-3 rounded-lg border border-border-default p-3">
          <span className="flex size-10 items-center justify-center rounded-control bg-success-bg text-success">
            <Banknote aria-hidden className="size-5" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-body font-semibold text-text-primary">Accept cash on delivery</span>
            <span className="text-caption text-text-muted">Customers pay the full amount when the parcel arrives</span>
          </span>
          <Toggle label="Accept cash on delivery" checked={cod} disabled={!editable} onChange={setCod} />
        </div>
        <div className={cn('flex items-center gap-3 rounded-lg border border-border-default p-3', !usable.length && 'opacity-60')}>
          <span className="flex size-10 items-center justify-center rounded-control bg-surface-subtle text-text-secondary">
            <Wallet aria-hidden className="size-5" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-body font-semibold text-text-primary">Collect delivery charge in advance</span>
            <span className="text-caption text-text-muted">{usable.length ? 'Cuts fake orders. Customers pay the delivery charge online first.' : 'Cuts fake orders. Needs a payment gateway below.'}</span>
          </span>
          <Toggle label="Collect delivery charge in advance" checked={advance && usable.length > 0} disabled={!editable || !usable.length} onChange={setAdvance} />
        </div>
      </OnboardingCard>

      <OnboardingCard title="Online & advance payments" description="Money goes straight to your own merchant account.">
        {gateways.isError ? (
          <ErrorBlock title="We couldn’t load payment gateways" error={gateways.error} onRetry={() => void gateways.refetch()} />
        ) : (
          <ul className="flex flex-col gap-3">
            {GATEWAYS.map((p) => {
              const a = accounts[p];
              const connected = isConnected(a);
              return (
                <li key={p} className="flex items-center gap-3 rounded-lg border border-border-default p-3">
                  <ProviderLogo provider={p} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex flex-wrap items-center gap-2 text-body font-semibold text-text-primary">
                      {gatewayMeta[p].name}
                      {connected && (
                        <Badge tone="success" dot>
                          Connected
                        </Badge>
                      )}
                    </span>
                    <span className="text-caption text-text-muted">{gatewayMeta[p].onboardingHint}</span>
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
        <p className="text-caption text-text-muted">Not ready? Start with cash on delivery and connect a gateway anytime from Integrations.</p>
        <p className="flex items-center gap-2 text-caption text-text-muted">
          <ShieldCheck aria-hidden className="size-4" /> Store Plix never holds your money.
        </p>
      </OnboardingCard>
      {connecting && <ConnectGatewayDialog provider={connecting} account={accounts[connecting]} onClose={() => setConnecting(null)} />}
    </OnboardingFrame>
  );
}

export default GetPaidPage;
