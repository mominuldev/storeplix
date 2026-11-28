import { cn, ProviderLogo, type ProviderLogoProps } from '@storeplix/ui';
import type { GatewayProvider } from '@storeplix/types';
import nagadLogo from './nagad.png';

// Phase 8.9d: `@storeplix/ui` ProviderLogo has no Nagad mark. Nagad uses the logo asset from Figma 2134:67228
// (header logo tile 2134:67685, 32 px mark in a bordered tile) at the same box sizes as ProviderLogo.
const sizes = {
  sm: 'size-8 rounded-control',
  md: 'size-10 rounded-control',
  lg: 'size-12 rounded-lg',
} as const;
const marks = { sm: 'size-5', md: 'size-6', lg: 'size-8' } as const;

export interface GatewayLogoProps extends Omit<ProviderLogoProps, 'provider'> {
  provider: GatewayProvider;
}

export function GatewayLogo({ provider, size = 'md', className, label }: GatewayLogoProps) {
  if (provider !== 'nagad') return <ProviderLogo provider={provider} size={size} className={className} label={label} />;
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true };
  return (
    <span {...a11y} className={cn('flex shrink-0 items-center justify-center border border-border-default bg-surface-card', sizes[size], className)}>
      <img alt="" src={nagadLogo} className={cn('rounded-md object-contain', marks[size])} />
    </span>
  );
}
