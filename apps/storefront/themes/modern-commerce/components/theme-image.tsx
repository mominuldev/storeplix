import Image from 'next/image';
import { isAllowedMediaOrigin } from '@/lib/media';

interface ThemeImageProps {
  src: string;
  alt: string;
  sizes: string;
  className?: string;
  priority?: boolean;
  /** Decided on the server when the image is rendered inside a client component (env is server-only). */
  unoptimized?: boolean;
}

/**
 * Fills its (relative) parent. Local theme assets and URLs on configured media origins
 * (STOREFRONT_MEDIA_ORIGINS -> next.config remotePatterns) are optimized by next/image; any other
 * https URL (already sanitized) is rendered unoptimized.
 */
export function ThemeImage({ src, alt, sizes, className = '', priority, unoptimized }: ThemeImageProps) {
  return (
    <Image
      src={src}
      alt={alt}
      fill
      sizes={sizes}
      priority={priority}
      unoptimized={unoptimized ?? (!src.startsWith('/') && !isAllowedMediaOrigin(src))}
      className={`object-cover ${className}`}
    />
  );
}
