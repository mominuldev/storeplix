import { notFound } from 'next/navigation';
import { requireCurrentStore } from '@/lib/store';

/**
 * Catch-all for paths without a route yet. Draft stores: the layout renders Coming soon (200) on
 * every path, so render nothing here. Live/preview stores: themed 404.
 */
export default async function CatchAllPage() {
  const { mode } = await requireCurrentStore();
  if (mode === 'coming_soon') return null;
  notFound();
}
