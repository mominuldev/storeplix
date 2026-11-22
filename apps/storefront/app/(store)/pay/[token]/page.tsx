import type { Metadata } from 'next';
import { requireCurrentStore } from '@/lib/store';
import { fetchPaymentLink, getClientIp } from '@/lib/commerce-api';
import { PAY_LINK_TOKEN_RE } from '@/lib/commerce-schemas';
import { getPreviewToken } from '@/lib/preview';
import { NOINDEX_ROBOTS } from '@/lib/seo';
import { InvalidPayLink, PayLinkPage } from '@/themes/modern-commerce/commerce/payment-pages';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Pay for your order', robots: NOINDEX_ROBOTS };

interface Props {
  params: Promise<{ token: string }>;
}

/**
 * `/pay/[token]` (P5B-23): merchant payment link. `private, no-store`, `noindex`, no Referer (proxy).
 * A malformed token never reaches the API; every non-active link renders the same invalid page.
 */
export default async function PayPage({ params }: Props) {
  const store = await requireCurrentStore();
  if (store.mode === 'coming_soon') return null;
  const { token } = await params;
  if (!PAY_LINK_TOKEN_RE.test(token)) return <InvalidPayLink />;
  const call = { host: store.host, previewToken: store.mode === 'preview' ? await getPreviewToken() : null, clientIp: await getClientIp() };
  const r = await fetchPaymentLink(call, token);
  if (!r.ok) return <InvalidPayLink />;
  return <PayLinkPage link={r.data} token={token} idempotencyKey={crypto.randomUUID()} />;
}
