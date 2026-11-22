import { Button, ProgressBar } from '@storeplix/ui';
import { ChevronLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { StepRail } from './StepRail';

// Shared chrome of onboarding 06 Delivery 50:604 and 07 Get paid 52:564 (same layout as 05 Add products 50:312):
// step rail, "Step N of 7 · Save & exit", content column, footer Back / Continue, right preview panel (lg+).

export function OnboardingFrame({
  step,
  shopName,
  title,
  subtitle,
  bangla,
  back,
  footer,
  aside,
  children,
}: {
  step: 6 | 7;
  shopName: string;
  title: string;
  subtitle: string;
  bangla?: string;
  back: string;
  footer: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const { user } = useAuth();
  return (
    <div className="flex min-h-dvh bg-surface-canvas">
      <StepRail shopName={shopName} current={step} phoneVerified={!!user?.phone_verified_at} />
      <div className="flex min-w-0 flex-1 flex-col lg:items-center">
        <div className="hidden w-full items-center justify-between px-10 py-5 lg:flex">
          <span className="text-caption font-medium text-text-secondary">Step {step} of 7</span>
          <Button variant="ghost" size="sm" onClick={() => navigate('/')}>
            Save & exit
          </Button>
        </div>
        <header className="flex flex-col gap-3 px-4 pt-2 pb-3 lg:hidden">
          <div className="flex items-center justify-between">
            <button type="button" aria-label="Back" onClick={() => navigate(back)} className="flex size-9 items-center justify-center rounded-full border border-border-default bg-surface-card">
              <ChevronLeft aria-hidden className="size-[18px]" />
            </button>
            <span className="text-body font-semibold text-text-primary">Step {step} of 7</span>
            <button type="button" onClick={() => navigate('/')} className="text-caption font-medium text-brand-600">
              Skip
            </button>
          </div>
          <ProgressBar value={step / 7} label="Setup progress" className="h-1 rounded-[2px]" />
        </header>
        <div className="flex w-full max-w-[600px] flex-1 flex-col gap-5 px-5 pt-3 pb-32 lg:gap-6 lg:px-0 lg:pt-2 lg:pb-12">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-heading-24 text-text-primary lg:text-heading-32">{title}</h1>
            <p className="text-body text-text-secondary lg:text-body-lg">{subtitle}</p>
            {bangla && (
              <p lang="bn" className="font-bangla text-body text-text-muted">
                {bangla}
              </p>
            )}
          </div>
          {children}
          <div className="fixed inset-x-0 bottom-0 z-10 flex items-center justify-between gap-3 border-t border-border-default bg-surface-card px-5 pt-4 pb-[max(16px,env(safe-area-inset-bottom))] lg:static lg:border-0 lg:bg-transparent lg:p-0">
            <Button variant="ghost" className="hidden lg:inline-flex" leftIcon={<ChevronLeft aria-hidden className="size-4" />} onClick={() => navigate(back)}>
              Back
            </Button>
            <span className="flex flex-1 items-center justify-end gap-2">{footer}</span>
          </div>
        </div>
      </div>
      {aside && <aside className="hidden w-[340px] shrink-0 flex-col gap-4 bg-brand-50 px-8 py-6 xl:flex">{aside}</aside>}
    </div>
  );
}

export function OnboardingCard({ title, description, children, label }: { title: string; description?: string; children: ReactNode; label?: string }) {
  return (
    <section aria-label={label ?? title} className="flex flex-col gap-4 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1">
      <div className="flex flex-col gap-1">
        <h2 className="text-body-lg font-semibold text-text-primary">{title}</h2>
        {description && <p className="text-body text-text-secondary">{description}</p>}
      </div>
      {children}
    </section>
  );
}
