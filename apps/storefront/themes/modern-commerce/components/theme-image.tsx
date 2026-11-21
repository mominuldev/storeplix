import Image from 'next/image';
import { isAllowedMediaOrigin } from '@/lib/media';

interface ThemeImageProps {
  src: string;
  alt: string;
  sizes: string;
  className?: string;
  priority?: boolean;
}

/**
 * Fills its (relative) parent. Local theme assets and URLs on configured media origins
 * (STOREFRONT_MEDIA_ORIGINS -> next.config remotePatterns) are optimized by next/image; any other
 * https URL (already sanitized) is rendered unoptimized.
 */
export function ThemeImage({ src, alt, sizes, className = '', priority }: ThemeImageProps) {
  return (
    <Image
      src={src}
      alt={alt}
      fill
      sizes={sizes}
      priority={priority}
      unoptimized={!src.startsWith('/') && !isAllowedMediaOrigin(src)}
      className={`object-cover ${className}`}
    />
  );
}
