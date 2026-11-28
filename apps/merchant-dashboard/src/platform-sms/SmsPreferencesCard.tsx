import { isApiError } from '@storeplix/api-client';
import type { SmsPreferences } from '@storeplix/types';
import { Badge, Button, Skeleton, Toggle } from '@storeplix/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api';

const smsPreferencesKey = ['account', 'sms-preferences'] as const;

const TITLE = 'Store Plix SMS';
const SWITCH_LABEL = 'Offers and news from Store Plix by SMS';
const CAPTION = 'Sign-in codes, invoices and account messages are always sent.';

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section aria-label={TITLE} className="flex flex-col gap-3 rounded-card border border-border-default bg-surface-card p-6 shadow-elevation-1">
      <div className="flex flex-col gap-1">
        <h2 className="text-body-lg font-medium text-text-primary">{TITLE}</h2>
        <p className="text-body text-text-secondary">{CAPTION}</p>
      </div>
      {children}
    </section>
  );
}

function Row({ phone, control }: { phone: React.ReactNode; control: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-t border-border-default pt-3.5">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-body font-medium text-text-primary">{SWITCH_LABEL}</span>
        <span className="text-caption text-text-secondary">{phone}</span>
      </span>
      {control}
    </div>
  );
}

function phoneLine(p: SmsPreferences) {
  if (p.phone_masked && p.phone_verified) return <>Sent to {p.phone_masked}</>;
  return (
    <>
      Add and verify a phone number to receive SMS.{' '}
      {p.phone_masked && (
        <Link to="/verify-phone" className="font-semibold text-brand-600 hover:text-brand-700">
          Verify
        </Link>
      )}
    </>
  );
}

/** PHASE-8-9B §12: Account → "Store Plix SMS" (`account.smsPreferences`); the signed-in user's own row, no tenant. */
export function SmsPreferencesCard() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const prefs = useQuery({ queryKey: smsPreferencesKey, queryFn: () => api.account.smsPreferences.get(), retry: false });
  const update = useMutation({
    mutationFn: (promotional: boolean) => api.account.smsPreferences.update({ promotional }),
    onMutate: () => setError(null),
    onSuccess: (data) => qc.setQueryData(smsPreferencesKey, data),
    onError: (e) =>
      setError(isApiError(e) && e.status === 429 ? 'Too many changes. Please wait a minute and try again.' : 'Couldn’t save your SMS preference. Please try again.'),
  });

  if (prefs.isPending) {
    return (
      <Shell>
        <div role="status" aria-label="Loading SMS preferences" className="flex items-center gap-3 border-t border-border-default pt-3.5">
          <span className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-2.5 w-3/5 rounded-full" />
            <Skeleton className="h-2.5 w-1/3 rounded-full" />
          </span>
          <Skeleton className="h-6 w-10 rounded-full" />
        </div>
      </Shell>
    );
  }

  if (prefs.isError) {
    return (
      <Shell>
        <div role="alert" className="flex items-center gap-3 border-t border-border-default pt-3.5">
          <span className="flex-1 text-body text-danger">Couldn’t load your SMS preferences.</span>
          <Button variant="secondary" size="sm" onClick={() => void prefs.refetch()}>
            Try again
          </Button>
        </div>
      </Shell>
    );
  }

  const p = prefs.data;
  const checked = update.isPending && update.variables !== undefined ? update.variables : p.promotional;
  return (
    <Shell>
      <Row phone={phoneLine(p)} control={<Toggle checked={checked} disabled={update.isPending} label={SWITCH_LABEL} onChange={(v) => update.mutate(v)} />} />
      {error && (
        <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-body text-danger">
          {error}
        </p>
      )}
    </Shell>
  );
}

/**
 * In a read-only support session `/auth/me` is the platform staff member, so the preference is neither loaded nor
 * changeable here (contract §12: read-only while impersonating; the API answers 403).
 */
export function SmsPreferencesCardReadOnly() {
  return (
    <Shell>
      <Row phone="Each person on the shop sets this for themselves. It can’t be viewed or changed in a support session." control={<Badge>View only</Badge>} />
    </Shell>
  );
}
