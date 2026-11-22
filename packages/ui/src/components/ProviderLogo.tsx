import { cn } from '../lib/cn';

// Figma Integrations 14:980 (card logo tile 32:3808: 40px, radius 10, border-default, 28px mark radius 6) and the
// connect wizard 32:4107 (48px, radius 12). bKash is drawn in Figma as a wordmark on its brand pink (32:3872); the
// other marks are the PNGs exported from Figma. The pink is the third-party brand colour, not a theme token.
export type ProviderLogoId = 'bkash' | 'sslcommerz' | 'steadfast' | 'pathao' | 'redx';

const marks: Record<Exclude<ProviderLogoId, 'bkash'>, string> = {
  sslcommerz: new URL('../assets/providers/sslcommerz.png', import.meta.url).href,
  steadfast: new URL('../assets/providers/steadfast.png', import.meta.url).href,
  pathao: new URL('../assets/providers/pathao.png', import.meta.url).href,
  redx: new URL('../assets/providers/redx.png', import.meta.url).href,
};

const names: Record<ProviderLogoId, string> = { bkash: 'bKash', sslcommerz: 'SSLCommerz', steadfast: 'Steadfast', pathao: 'Pathao', redx: 'RedX' };

const sizes = {
  sm: { box: 'size-8 rounded-control', mark: 'size-6', text: 'text-[9px]' },
  md: { box: 'size-10 rounded-control', mark: 'size-7', text: 'text-[10px]' },
  lg: { box: 'size-12 rounded-lg', mark: 'size-9', text: 'text-caption' },
} as const;

export interface ProviderLogoProps {
  provider: ProviderLogoId;
  size?: keyof typeof sizes;
  className?: string;
  /** Decorative by default (the name is printed next to it). */
  label?: string;
}

export function ProviderLogo({ provider, size = 'md', className, label }: ProviderLogoProps) {
  const s = sizes[size];
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true };
  if (provider === 'bkash') {
    return (
      <span {...a11y} className={cn('flex shrink-0 items-center justify-center bg-[#e2136e] font-bold text-text-inverse', s.box, s.text, className)}>
        {names.bkash}
      </span>
    );
  }
  return (
    <span {...a11y} className={cn('flex shrink-0 items-center justify-center overflow-hidden border border-border-default bg-surface-card', s.box, className)}>
      <img alt="" src={marks[provider]} className={cn('rounded-sm object-contain', s.mark)} />
    </span>
  );
}
