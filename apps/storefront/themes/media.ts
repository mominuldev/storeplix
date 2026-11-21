import type { StorefrontMedia } from '@storeplix/types';

/**
 * Resolve a theme `*MediaId` through the response's media map. Unresolved ids (null, deleted,
 * failed, or from a payload without `media`) fall back to the section's bundled demo image.
 */
export function themeImage(
  media: Record<string, StorefrontMedia>,
  id: string | null | undefined,
  demo: string,
): { src: string; alt: string | null; isDemo: boolean } {
  const m = id ? media[id] : undefined;
  return m ? { src: m.url, alt: m.alt, isDemo: false } : { src: demo, alt: null, isDemo: true };
}

export const DEMO = '/themes/modern-commerce/images';
