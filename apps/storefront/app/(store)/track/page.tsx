import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { requireCurrentStore } from '@/lib/store';
import { NOINDEX_ROBOTS } from '@/lib/seo';
import { whatsappHref } from '@/lib/contact';
import { getClientIp } from '@/lib/commerce-api';
import { getOrderByAccess } from '@/lib/inbox';
import { ORDER_ACCESS_COOKIE, parseOrderAccessCookie } from '@/lib/inbox-shared';
import { toShopperTracking, type ShopperTracking } from '@/lib/tracking';
import { TrackForm } from '@/themes/modern-commerce/commerce/track-form';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Track your order', robots: NOINDEX_ROBOTS };

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * 8.8e §9.3: `/track?view=messages` (after a reply-SMS magic link) shows the order held in the httpOnly
 * `sp_order_access` cookie with its Messages card. A missing/expired token simply shows the empty track form.
 */
async function heldOrder(host: string): Promise<ShopperTracking | null> {
  const held = parseOrderAccessCookie((await cookies()).get(ORDER_ACCESS_COOKIE)?.value);
  if (!held) return null;
  const r = await getOrderByAccess({ host, clientIp: await getClientIp(), auth: { orderAccess: held.token } });
  if (!r.ok || !('data' in r) || r.data.number.toUpperCase() !== held.number) return null;
  return toShopperTracking(r.data);
}

/** `/track` — Figma 1:11959, mobile 33:5864. Order number + phone, no login (P5-23, Q42). */
export default async function TrackPage({ searchParams }: Props) {
  const store = await requireCurrentStore();
  if (store.mode === 'coming_soon') return null;
  const params = await searchParams;
  const raw = params.number;
  const number = typeof raw === 'string' && /^[A-Za-z0-9-]{1,24}$/.test(raw) ? raw.toUpperCase() : '';
  const initialTracking = params.view === 'messages' && store.mode === 'live' && store.config.inbox?.order_messages ? await heldOrder(store.host) : null;
  return (
    <div className="px-4 pt-8 pb-20 lg:px-20 lg:pt-14 lg:pb-28">
      <TrackForm initialNumber={number} whatsapp={whatsappHref(store.config.contact.whatsapp)} initialTracking={initialTracking} />
    </div>
  );
}
