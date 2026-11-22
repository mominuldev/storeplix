import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireCurrentStore } from '@/lib/store';
import { fetchConfirmation, getClientIp } from '@/lib/commerce-api';
import { getOrderToken } from '@/lib/commerce-context';
import { getPreviewToken } from '@/lib/preview';
import { NOINDEX_ROBOTS } from '@/lib/seo';
import { whatsappHref } from '@/lib/contact';
import { OrderConfirmation } from '@/themes/modern-commerce/commerce/order-confirmation';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Order placed', robots: NOINDEX_ROBOTS };

/**
 * `/checkout/thank-you` — Figma 1:11788, mobile 33:5751. From the httpOnly `sp_order` cookie (P5-23).
 * 5b-2: shows the payment line; an unpaid `pending_payment` order gets Retry / Pay on delivery.
 */
export default async function ThankYouPage() {
  const store = await requireCurrentStore();
  if (store.mode === 'coming_soon') return null;
  const token = await getOrderToken();
  if (!token) redirect('/');
  const preview = store.mode === 'preview' ? await getPreviewToken() : null;
  const r = await fetchConfirmation(store.host, token, preview, await getClientIp());
  if (!r.ok) redirect('/');
  return <OrderConfirmation order={r.data} whatsappHref={whatsappHref(store.config.contact.whatsapp)} hero={{ kind: 'auto' }} retryKey={crypto.randomUUID()} />;
}
