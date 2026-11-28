import { isApiError } from '@storeplix/api-client';
import { Button, Spinner } from '@storeplix/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff, CheckCircle2, Clock, LinkIcon, MessageSquare } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../lib/api';
import { AuthShell, FormAlert, FormTitle } from '../onboarding/AuthShell';

const BANGLA = 'Store Plix-এর অফার SMS বন্ধ করুন।';
/** P89B-21: 10 base62 chars; `test` is the admin test-send code (§7.5). */
const CODE_RE = /^[A-Za-z0-9]{10}$/;
const TEST_CODE = 'test';

const ALWAYS_SENT = 'Sign-in codes, invoices and account messages are always sent.';

function retryText(seconds: number | undefined): string {
  if (!seconds || seconds <= 60) return 'Please wait a minute and try again.';
  return `Please wait ${Math.ceil(seconds / 60)} minutes and try again.`;
}

function isNotFound(e: unknown): boolean {
  return isApiError(e) && e.status === 404;
}

function isRateLimited(e: unknown): boolean {
  return isApiError(e) && e.status === 429;
}

function State({ icon, title, subtitle, role = 'status', children }: { icon: ReactNode; title: string; subtitle?: ReactNode; role?: 'status' | 'alert'; children?: ReactNode }) {
  return (
    <div role={role} className="flex flex-col gap-4">
      <span aria-hidden className="[&>svg]:size-10">
        {icon}
      </span>
      <FormTitle title={title} subtitle={subtitle} />
      {children}
    </div>
  );
}

function AccountLink() {
  return (
    <Link to="/account" className="self-start text-body font-semibold text-brand-600 hover:text-brand-700">
      Go to your account
    </Link>
  );
}

/**
 * PHASE-8-9B §7.6/§12 public `/s/:code` (outside the auth shell, no tenant, noindex). GET only shows the state; the
 * "Stop offers" button POSTs (idempotent). Turning offers back on happens on Account → Store Plix SMS (signed in) —
 * the contract has no public re-subscribe call.
 */
export function OptOutPage() {
  const { code = '' } = useParams();
  const isTest = code === TEST_CODE;
  const wellFormed = CODE_RE.test(code);
  const qc = useQueryClient();
  const queryKey = ['platform-sms', 'opt-out', code] as const;

  const lookup = useQuery({ queryKey, queryFn: () => api.platformSms.optOutLookup(code), enabled: wellFormed && !isTest, retry: false });
  const stop = useMutation({
    mutationFn: () => api.platformSms.optOut(code),
    onSuccess: (data) => qc.setQueryData(queryKey, data),
  });

  let body: ReactNode;
  if (isTest) {
    body = (
      <State icon={<MessageSquare className="text-brand-600" />} title="This was a test message" subtitle="It was sent by the Store Plix team to check SMS delivery. Nothing has changed on your account." />
    );
  } else if (!wellFormed || isNotFound(lookup.error) || isNotFound(stop.error)) {
    body = (
      <State
        role="alert"
        icon={<LinkIcon className="text-text-muted" />}
        title="This link is not valid"
        subtitle="It may have expired or been copied incompletely. You can still turn Store Plix offers off in your account."
      >
        <AccountLink />
      </State>
    );
  } else if (lookup.isPending) {
    body = (
      <div role="status" aria-label="Checking your link" className="flex items-center gap-3 py-8 text-body text-text-secondary">
        <Spinner /> Checking your link…
      </div>
    );
  } else if (lookup.isError) {
    const limited = isRateLimited(lookup.error);
    body = (
      <State
        role="alert"
        icon={<Clock className="text-warning" />}
        title={limited ? 'Too many tries' : 'Something went wrong'}
        subtitle={limited ? retryText(isApiError(lookup.error) ? lookup.error.retryAfter : undefined) : 'We couldn’t check this link. Please try again.'}
      >
        <Button variant="secondary" className="self-start" loading={lookup.isFetching} onClick={() => void lookup.refetch()}>
          Try again
        </Button>
      </State>
    );
  } else if (lookup.data.status === 'opted_out') {
    body = (
      <State
        icon={<CheckCircle2 className="text-success" />}
        title="You won’t get Store Plix offers by SMS any more"
        subtitle={`You can turn them back on in your account. ${ALWAYS_SENT}`}
      >
        <AccountLink />
      </State>
    );
  } else {
    const stopError = stop.error
      ? isRateLimited(stop.error)
        ? `Too many tries. ${retryText(isApiError(stop.error) ? stop.error.retryAfter : undefined)}`
        : 'We couldn’t stop the offers. Please try again.'
      : null;
    body = (
      <div className="flex flex-col gap-4 lg:gap-7">
        <span aria-hidden className="[&>svg]:size-10">
          <BellOff className="text-brand-600" />
        </span>
        <FormTitle title={
            <>
              Stop Store Plix offers to <span className="whitespace-nowrap">{lookup.data.phone_masked}?</span>
            </>
          } subtitle={`You’ll no longer get offers and news from Store Plix by SMS. ${ALWAYS_SENT}`} />
        {stopError && <FormAlert>{stopError}</FormAlert>}
        <Button fullWidth className="min-h-12" loading={stop.isPending} onClick={() => stop.mutate()}>
          Stop offers
        </Button>
      </div>
    );
  }

  return (
    <>
      <title>Store Plix SMS offers</title>
      <meta name="robots" content="noindex, nofollow" />
      <AuthShell
        pitch={{ eyebrow: 'Your shop, orders and money — in one place', headline: 'Fewer messages, your choice.', bangla: BANGLA }}
        topLeft="Store Plix SMS"
        topRight={
          <Link to="/account" className="text-body font-semibold text-brand-600 hover:text-brand-700">
            Your account
          </Link>
        }
        mobile={{ variant: 'hero', title: 'Store Plix SMS', bangla: BANGLA }}
        showTrustRow={false}
      >
        {body}
      </AuthShell>
    </>
  );
}
