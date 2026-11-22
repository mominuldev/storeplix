import { Logo, cn } from '@storeplix/ui';
import type { ReactNode } from 'react';
import { BrandPanel, type PitchCopy } from './BrandPanel';
import { TrustRow } from './TrustRow';

interface AuthShellProps {
  pitch: PitchCopy;
  /** Desktop top bar, left (e.g. "Welcome back" or step progress). */
  topLeft: ReactNode;
  /** Desktop top bar, right (prompt + link). */
  topRight: ReactNode;
  /**
   * Mobile layout. `hero` = L5 58:1132 (gradient hero + floating card);
   * `plain` = M1 53:758 (app bar + flat body).
   */
  mobile: { variant: 'hero'; title: string; bangla: string } | { variant: 'plain'; action: ReactNode };
  /** Mobile-only footer below the form. */
  mobileFooter?: ReactNode;
  showTrustRow?: boolean;
  children: ReactNode;
}

// Shared desktop frame of Merchant Onboarding sign-in/sign-up (1440: 560 brand panel + main pt 32 pb 40 px 64,
// 440 form column). Children render once; breakpoints restyle the wrapper.
export function AuthShell({ pitch, topLeft, topRight, mobile, mobileFooter, showTrustRow = true, children }: AuthShellProps) {
  return (
    <div className="flex min-h-dvh bg-surface-canvas">
      <BrandPanel {...pitch} />
      <div className="flex min-w-0 flex-1 flex-col lg:items-center lg:justify-between lg:gap-8 lg:px-16 lg:pt-8 lg:pb-10">
        <div className="hidden w-full items-center justify-between lg:flex">
          <div className="flex items-center gap-3 text-caption font-medium text-text-secondary">{topLeft}</div>
          <div className="flex items-center gap-1.5 text-body text-text-secondary">{topRight}</div>
        </div>

        {mobile.variant === 'hero' ? (
          <header className="flex flex-col gap-3.5 bg-[linear-gradient(151.3deg,#5b53ff_0%,#453ddb_71.4%)] px-6 pt-5 pb-7 text-text-inverse lg:hidden">
            <Logo tone="inverse" height={32} />
            <h1 className="text-heading-24">{mobile.title}</h1>
            <p lang="bn" className="font-bangla text-body opacity-85">
              {mobile.bangla}
            </p>
          </header>
        ) : (
          <header className="flex items-center justify-between px-5 py-2 lg:hidden">
            <Logo height={32} />
            {mobile.action}
          </header>
        )}

        <main
          className={cn(
            'flex w-full flex-col lg:w-[440px] lg:max-w-full',
            mobile.variant === 'hero'
              ? 'px-4 lg:px-0'
              : 'px-5 pt-5 pb-7 lg:p-0',
          )}
        >
          <div
            className={cn(
              'flex flex-col',
              mobile.variant === 'hero' &&
                'gap-4 rounded-[20px] bg-surface-card px-5 py-[22px] shadow-elevation-1 lg:gap-0 lg:rounded-none lg:bg-transparent lg:p-0 lg:shadow-none',
            )}
          >
            {children}
          </div>
        </main>

        {showTrustRow ? <TrustRow /> : <div className="hidden lg:block" />}
        {mobileFooter && <footer className="flex flex-col items-center gap-1.5 py-6 text-center lg:hidden">{mobileFooter}</footer>}
      </div>
    </div>
  );
}

/** Figma onboarding form title — Heading/32 desktop. */
export function FormTitle({ title, subtitle, className }: { title: ReactNode; subtitle?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <h2 className="text-heading-32 text-text-primary">{title}</h2>
      {subtitle && <p className="text-body-lg text-text-secondary">{subtitle}</p>}
    </div>
  );
}

export function SessionNotice({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="rounded-md bg-info-bg px-3 py-2 text-body text-info">
      {children}
    </p>
  );
}

export function FormAlert({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-body text-danger">
      {children}
    </p>
  );
}
