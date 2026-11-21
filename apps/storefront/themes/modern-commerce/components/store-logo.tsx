import { sanitizeImageUrl } from '@/lib/sanitize';
import type { ThemeStore } from '../../types';

interface StoreLogoProps {
  store: ThemeStore;
  /** "On dark" variant: white chip so a two-tone logo stays legible on navy (Figma 1:9330). */
  onDark?: boolean;
  size?: 'md' | 'sm';
}

/**
 * Figma "Logo" (1:9326). The theme shows the merchant's uploaded logo; stores without one get a
 * wordmark of the store name in the heading face (the Figma artwork is merchant-specific).
 */
export function StoreLogo({ store, onDark = false, size = 'md' }: StoreLogoProps) {
  const logo = sanitizeImageUrl(store.logo_url);
  const height = size === 'md' ? 'h-[52px]' : 'h-[44px]';
  const content = logo ? (
    // Merchant logo from the media CDN; dimensions unknown, so a plain img with fixed height.
    // Fixed height (no layout shift on load); width follows the logo's aspect ratio.
    <img
      src={logo}
      alt={store.name}
      height={size === 'md' ? 52 : 44}
      decoding="async"
      className={`${height} w-auto max-w-[220px] object-contain`}
    />
  ) : (
    <span
      className={`block max-w-[240px] truncate font-heading leading-[1.1] font-semibold tracking-[-0.5px] text-brand ${size === 'md' ? 'text-[28px]' : 'text-[24px]'}`}
    >
      {store.name}
    </span>
  );

  if (!onDark) return content;
  return <span className="inline-flex items-center rounded-full bg-surface py-2 pr-[18px] pl-[10px]">{content}</span>;
}
