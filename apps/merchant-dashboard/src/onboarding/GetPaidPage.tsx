import { isApiError } from '@storeplix/api-client';
import type { LaunchItemKey } from '@storeplix/types';
import { Badge, Button, Toggle } from '@storeplix/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Banknote, ChevronRight, CreditCard, ShieldCheck, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { useStoreScope } from '../catalog/scope';
import { errorMessage } from '../catalog/states';
import { useCommerceInvalidate } from '../commerce/queries';
import { api } from '../lib/api';
import { LoadingState } from '../online-store/components/Shell';
import { useStoreSettings } from '../settings/commerceSettings';
import { settingsKey } from '../settings/schema';
import { storeKey } from '../stores/useTenantStore';
import { FormAlert } from './AuthShell';
import { blockerLinks } from './launch';
import { OnboardingCard, OnboardingFrame } from './OnboardingFrame';

// Figma Merchant Onboarding · 07 Get paid 52:564. Contract §9: COD card with toggle (`checkout.cod_enabled`);
// "Collect delivery charge in advance" disabled; bKash / SSLCommerz / EPS cards disabled ("Coming soon", 5b);
// Finish setup → POST /publish; 409 `launch_blocked` → inline blockers with links; success → /onboarding/live.

const GATEWAYS = [
  { name: 'bKash Payment Gateway', hint: 'Customers pay from their bKash app' },
  { name: 'SSLCommerz', hint: 'Cards, Nagad, Rocket and 30+ banks' },
  { name: 'EPS', hint: 'Cards and mobile wallets' },
];

export function GetPaidPage() {
  const { store } = useStoreScope();
  const settings = useStoreSettings();
  if (!store || settings.isPending) return <LoadingState label="Loading" />;
  return <GetPaidForm initialCod={settings.data?.commerce?.checkout.cod_enabled ?? true} />;
}

function GetPaidForm({ initialCod }: { initialCod: boolean }) {
  const navigate = useNavigate();
  const scope = useStoreScope();
  const { tenantId } = useAuth();
  const qc = useQueryClient();
  const invalidate = useCommerceInvalidate();
  const editable = scope.canManageSettings;
  const [cod, setCod] = useState(initialCod);
  const [blockers, setBlockers] = useState<{ key: LaunchItemKey; message: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const finish = useMutation({
    mutationFn: async () => {
      if (cod !== initialCod) {
        const s = await api.stores.updateSettings(scope.storeId!, { checkout: { cod_enabled: cod } });
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
          <label className="flex items-center gap-3 rounded-lg border border-brand-600 bg-brand-50 p-3">
            <input type="radio" readOnly checked={cod} className="accent-brand-600" />
            <span className="flex flex-col">
              <span className="text-body font-medium text-text-primary">Cash on delivery</span>
              <span className="text-caption text-text-muted">Pay when it arrives</span>
            </span>
          </label>
          <p className="text-caption text-text-muted">Online payments show here once they’re available.</p>
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
        <div className="flex items-center gap-3 rounded-lg border border-border-default p-3 opacity-60">
          <span className="flex size-10 items-center justify-center rounded-control bg-surface-subtle text-text-secondary">
            <Wallet aria-hidden className="size-5" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-body font-semibold text-text-primary">Collect delivery charge in advance</span>
            <span className="text-caption text-text-muted">Cuts fake orders — needs an online payment method</span>
          </span>
          <Badge>Coming soon</Badge>
        </div>
      </OnboardingCard>

      <OnboardingCard title="Online & advance payments" description="Money goes straight to your own merchant account.">
        <ul className="flex flex-col gap-3">
          {GATEWAYS.map((g) => (
            <li key={g.name} className="flex items-center gap-3 rounded-lg border border-border-default p-3 opacity-70">
              <span className="flex size-10 items-center justify-center rounded-control bg-surface-subtle text-text-secondary">
                <CreditCard aria-hidden className="size-5" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-body font-semibold text-text-primary">{g.name}</span>
                <span className="text-caption text-text-muted">{g.hint}</span>
              </span>
              <Badge>Coming soon</Badge>
              <Button size="sm" variant="secondary" disabled aria-label={`Connect ${g.name} (coming soon)`}>
                Connect
              </Button>
            </li>
          ))}
        </ul>
        <p className="flex items-center gap-2 text-caption text-text-muted">
          <ShieldCheck aria-hidden className="size-4" /> Store Plix never holds your money.
        </p>
      </OnboardingCard>
    </OnboardingFrame>
  );
}

export default GetPaidPage;
