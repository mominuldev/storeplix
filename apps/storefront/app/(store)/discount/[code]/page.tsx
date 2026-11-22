import type { Metadata } from 'next';
import { requireCurrentStore } from '@/lib/store';
import { NOINDEX_ROBOTS } from '@/lib/seo';
import { DiscountApply } from '@/themes/modern-commerce/commerce/discount-apply';
import { PageTitle } from '@/themes/modern-commerce/commerce/ui';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Discount code', robots: NOINDEX_ROBOTS };

interface Props {
  params: Promise<{ code: string }>;
}

/** Coupon share link `/discount/{CODE}` (Q38): applies the code, then always redirects to `/` (S14). */
export default async function DiscountPage({ params }: Props) {
  const store = await requireCurrentStore();
  if (store.mode === 'coming_soon') return null;
  let raw = (await params).code;
  try {
    raw = decodeURIComponent(raw);
  } catch {
    raw = '';
  }
  raw = raw.trim().toUpperCase();
  const code = /^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(raw) ? raw : '';
  return (
    <div className="flex flex-col items-start gap-6 px-4 pt-10 pb-20 lg:px-20 lg:pt-14">
      <PageTitle title={code ? `Code ${code}` : 'Discount code'} />
      {code ? <DiscountApply code={code} /> : <p className="type-body-m text-ink-secondary">This code doesn&apos;t exist.</p>}
    </div>
  );
}
