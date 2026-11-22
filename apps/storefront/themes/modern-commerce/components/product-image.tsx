import type { StorefrontMedia } from '@storeplix/types';
import { Icon } from './icon';
import { ThemeImage } from './theme-image';

/**
 * Product photo filling its (relative) parent. A product without an image shows the theme's
 * neutral placeholder (sunken surface + muted bag icon), never a demo product photo.
 */
export function ProductImage({ image, sizes }: { image: StorefrontMedia | null; sizes: string }) {
  if (image) return <ThemeImage src={image.url} alt="" sizes={sizes} />;
  return (
    <span data-sp-image-placeholder aria-hidden className="absolute inset-0 flex items-center justify-center bg-sunken text-ink-muted opacity-60">
      <Icon name="bag" size={32} />
    </span>
  );
}
