import type { CSSProperties } from 'react';

/** Icon assets exported from Figma into /public/themes/modern-commerce/icons (sizes = Figma root size). */
const ICONS = {
  'arrow-right': 20,
  'arrow-up-right': 18,
  bag: 20,
  'bag-inverse': 18,
  'caret-down': 14,
  eyelet: 10,
  facebook: 20,
  heart: 20,
  instagram: 20,
  list: 18,
  menu: 20,
  phone: 16,
  search: 20,
  snowflake: 16,
  sparkle: 16,
  'sparkle-sm': 14,
  star: 14,
  'star-inverse': 14,
  tag: 18,
  user: 20,
  youtube: 20,
} as const;

export type IconName = keyof typeof ICONS;

interface IconProps {
  name: IconName;
  /** Rendered size in px. Defaults to the asset's Figma size. */
  size?: number;
  className?: string;
  /** Keep the asset's own colors instead of tinting with currentColor. */
  original?: boolean;
}

export function Icon({ name, size = ICONS[name], className = '', original = false }: IconProps) {
  const src = `/themes/modern-commerce/icons/${name}.svg`;
  if (original) {
    return <img src={src} alt="" aria-hidden width={size} height={size} className={`shrink-0 ${className}`} />;
  }
  const style: CSSProperties = { width: size, height: size, maskImage: `url(${src})`, WebkitMaskImage: `url(${src})` };
  return <span aria-hidden className={`icon-mask ${className}`} style={style} />;
}
