import type { Metadata } from 'next';
import { requireCurrentStore } from '@/lib/store';
import { getClientIp } from '@/lib/commerce-api';
import { getPreviewToken } from '@/lib/preview';
import { resolvePaymentResult } from '@/lib/payment-result';
import { NOINDEX_ROBOTS } from '@/lib/seo';
import { PaymentResultCard, PaymentResultMissing } from '@/themes/modern-commerce/commerce/payment-pages';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Payment', robots: NOINDEX_ROBOTS };

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** `/pay/result?payment=` (P5B-18): result of a payment-link payment. Status only, no PII. */
export default async function PayResultPage({ searchParams }: Props) {
  const store = await requireCurrentStore();
  if (store.mode === 'coming_soon') return null;
  const payment = (await searchParams).payment;
  const call = { host: store.host, previewToken: store.mode === 'preview' ? await getPreviewToken() : null, clientIp: await getClientIp() };
  // Link payments never use the checkout cookie: the card is all a link payer sees.
  const view = await resolvePaymentResult(call, payment, null);
  if (view.kind === 'card') return <PaymentResultCard result={view.result} paymentId={String(payment)} variant="link" />;
  return <PaymentResultMissing unavailable={view.kind === 'unavailable'} />;
}
