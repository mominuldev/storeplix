import type { Metadata } from 'next';
import { requireCurrentStore } from '@/lib/store';
import { getClientIp } from '@/lib/commerce-api';
import { getOrderToken } from '@/lib/commerce-context';
import { getPreviewToken } from '@/lib/preview';
import { resolvePaymentResult } from '@/lib/payment-result';
import { NOINDEX_ROBOTS } from '@/lib/seo';
import { whatsappHref } from '@/lib/contact';
import { OrderConfirmation } from '@/themes/modern-commerce/commerce/order-confirmation';
import { PaymentResultCard, PaymentResultMissing } from '@/themes/modern-commerce/commerce/payment-pages';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Payment', robots: NOINDEX_ROBOTS };

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * `/checkout/payment-result?payment=` (PHASE-5B-CONTRACT §11, §5.3): where the API's signed return
 * 303-redirects after verifying. `private, no-store` (proxy). Paid → thank-you view; pending → polls;
 * failed/cancelled → Retry / Pay on delivery. Without the shopper's `sp_order` → a minimal card.
 */
export default async function PaymentResultPage({ searchParams }: Props) {
  const store = await requireCurrentStore();
  if (store.mode === 'coming_soon') return null;
  const payment = (await searchParams).payment;
  const call = { host: store.host, previewToken: store.mode === 'preview' ? await getPreviewToken() : null, clientIp: await getClientIp() };
  const view = await resolvePaymentResult(call, payment, await getOrderToken());
  switch (view.kind) {
    case 'invalid':
    case 'unavailable':
      return <PaymentResultMissing unavailable={view.kind === 'unavailable'} />;
    case 'card':
      return <PaymentResultCard result={view.result} paymentId={String(payment)} variant="checkout" />;
    case 'order':
      return (
        <OrderConfirmation
          order={view.order}
          whatsappHref={whatsappHref(store.config.contact.whatsapp)}
          hero={view.pending ? { kind: 'pending', paymentId: String(payment) } : { kind: 'auto' }}
          retryKey={crypto.randomUUID()}
        />
      );
  }
}
