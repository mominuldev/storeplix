import type { Metadata } from 'next';
import { requireCurrentStore } from '@/lib/store';
import { NOINDEX_ROBOTS } from '@/lib/seo';
import { whatsappHref } from '@/lib/contact';
import { TrackForm } from '@/themes/modern-commerce/commerce/track-form';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Track your order', robots: NOINDEX_ROBOTS };

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** `/track` — Figma 1:11959, mobile 33:5864. Order number + phone, no login (P5-23, Q42). */
export default async function TrackPage({ searchParams }: Props) {
  const store = await requireCurrentStore();
  if (store.mode === 'coming_soon') return null;
  const raw = (await searchParams).number;
  const number = typeof raw === 'string' && /^[A-Za-z0-9-]{1,24}$/.test(raw) ? raw.toUpperCase() : '';
  return (
    <div className="px-4 pt-8 pb-20 lg:px-20 lg:pt-14 lg:pb-28">
      <TrackForm initialNumber={number} whatsapp={whatsappHref(store.config.contact.whatsapp)} />
    </div>
  );
}
