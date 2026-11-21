import Image from 'next/image';

interface ThemeImageProps {
  src: string;
  alt: string;
  sizes: string;
  className?: string;
  priority?: boolean;
}

/**
 * Fills its (relative) parent. Local theme assets are optimized by next/image; merchant/CDN
 * https URLs (already sanitized by the theme schema) are rendered unoptimized until the
 * media CDN host list is configured in next.config remotePatterns.
 */
export function ThemeImage({ src, alt, sizes, className = '', priority }: ThemeImageProps) {
  return (
    <Image
      src={src}
      alt={alt}
      fill
      sizes={sizes}
      priority={priority}
      unoptimized={!src.startsWith('/')}
      className={`object-cover ${className}`}
    />
  );
}
