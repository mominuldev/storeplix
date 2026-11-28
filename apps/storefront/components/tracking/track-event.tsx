'use client';

import { useEffect, useRef } from 'react';
import { emitTrack, type TrackInput } from '@/lib/tracking-events';

/**
 * Reports one page event (`view_item` on a product page, `begin_checkout` once per checkout page view) to the tracking
 * runtime. Rendered by pages only when tracking is on for a live shop; renders nothing. Deferred one tick so the
 * runtime's `page_view` for the same navigation goes first.
 */
export function TrackEvent(props: TrackInput) {
  const input = useRef(props);
  useEffect(() => {
    const t = setTimeout(() => emitTrack(input.current, { buffer: true }), 0);
    return () => clearTimeout(t);
  }, []);
  return null;
}
