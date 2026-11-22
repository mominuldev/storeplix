import { cn } from '../lib/cn';

// Horizontal marks are the Figma Storeplix/Logo 117:32 exports (93.65 × 32): tone=default (117:18) and
// tone=inverse (117:31, coloured bag + white wordmark for brand/dark surfaces). Symbol/stacked come from
// assets/brand/svg. Rendered as <img> so SVG gradient ids never collide.
const symbol = new URL('../assets/storeplix-symbol.svg', import.meta.url).href;
const stacked = new URL('../assets/storeplix-stacked.svg', import.meta.url).href;
const sources = {
  horizontal: {
    default: new URL('../assets/storeplix-horizontal.svg', import.meta.url).href,
    inverse: new URL('../assets/storeplix-horizontal-inverse.svg', import.meta.url).href,
    white: new URL('../assets/storeplix-horizontal-white.svg', import.meta.url).href,
  },
  symbol: {
    default: symbol,
    // The symbol keeps its colours on dark surfaces (Figma tone=inverse only recolours the wordmark).
    inverse: symbol,
    white: new URL('../assets/storeplix-symbol-white.svg', import.meta.url).href,
  },
  stacked: { default: stacked, inverse: stacked, white: stacked },
} as const;

// Intrinsic aspect ratios from each SVG viewBox.
const ratio = { horizontal: 93.65 / 32, symbol: 1, stacked: 561.68 / 482 } as const;

export interface LogoProps {
  variant?: keyof typeof sources;
  /** `inverse` (Figma tone=inverse) for brand/dark surfaces; `white` is the single-colour reversed mark. */
  tone?: 'default' | 'inverse' | 'white';
  /** Rendered height in px. Width follows the SVG aspect ratio. */
  height?: number;
  className?: string;
}

export function Logo({ variant = 'horizontal', tone = 'default', height = 28, className }: LogoProps) {
  return (
    <img
      src={sources[variant][tone]}
      alt="Storeplix"
      height={height}
      width={Math.round(height * ratio[variant])}
      className={cn('block shrink-0', className)}
      draggable={false}
    />
  );
}
