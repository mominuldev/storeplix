import { cn, ProviderLogo, type ProviderLogoProps } from '@storeplix/ui';
import type { GatewayProvider } from '@storeplix/types';

// Phase 8.9d: `GatewayProvider` gained `nagad` (PHASE-8-9D §15) but `@storeplix/ui` ProviderLogo has no Nagad mark yet
// (reported to ARCH). Until it does, Nagad renders a neutral wordmark tile with the same box sizes as ProviderLogo.
const sizes = {
  sm: 'size-8 rounded-control text-[9px]',
  md: 'size-10 rounded-control text-[10px]',
  lg: 'size-12 rounded-lg text-caption',
} as const;

export interface GatewayLogoProps extends Omit<ProviderLogoProps, 'provider'> {
  provider: GatewayProvider;
}

export function GatewayLogo({ provider, size = 'md', className, label }: GatewayLogoProps) {
  if (provider !== 'nagad') return <ProviderLogo provider={provider} size={size} className={className} label={label} />;
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true };
  return (
    <span {...a11y} className={cn('flex shrink-0 items-center justify-center border border-border-default bg-surface-card font-bold text-text-primary', sizes[size], className)}>
      Nagad
    </span>
  );
}
