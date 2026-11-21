import { cn } from '../lib/cn';

// Brand assets copied from assets/brand/svg. Rendered as <img> so SVG gradient ids never collide.
const sources = {
  horizontal: {
    default: new URL('../assets/storeplix-horizontal.svg', import.meta.url).href,
    white: new URL('../assets/storeplix-horizontal-white.svg', import.meta.url).href,
  },
  symbol: {
    default: new URL('../assets/storeplix-symbol.svg', import.meta.url).href,
    white: new URL('../assets/storeplix-symbol-white.svg', import.meta.url).href,
  },
  stacked: {
    default: new URL('../assets/storeplix-stacked.svg', import.meta.url).href,
    white: new URL('../assets/storeplix-stacked.svg', import.meta.url).href,
  },
} as const;

// Intrinsic aspect ratios from each SVG viewBox.
const ratio = { horizontal: 787.68 / 314, symbol: 1, stacked: 561.68 / 482 } as const;

export interface LogoProps {
  variant?: keyof typeof sources;
  /** `white` for dark surfaces (e.g. the platform admin sidebar). */
  tone?: 'default' | 'white';
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
