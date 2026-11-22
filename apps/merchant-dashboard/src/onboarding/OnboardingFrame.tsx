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
  asideNote = 'What your customer sees',
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
  /** Right-hand caption of the preview pane head (Figma 50:797 / 52:727). */
  asideNote?: string;
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
            <button type="button" onClick={() => navigate('/')} className="text-body font-medium text-brand-600">
              Save & exit
            </button>
          </div>
          <ProgressBar value={step / 7} label="Setup progress" className="h-1 rounded-[2px]" />
        </header>
        <div className="flex w-full max-w-[620px] flex-1 flex-col gap-5 px-5 pt-3 pb-32 lg:gap-7 lg:px-0 lg:pt-2 lg:pb-12">
          <div className="flex flex-col gap-1.5 lg:gap-2">
            <h1 className="text-heading-24 text-text-primary lg:text-heading-32">{title}</h1>
            <p className="text-body text-text-secondary lg:text-body-lg">{subtitle}</p>
            {bangla && (
              <p lang="bn" className="font-bangla text-body text-text-muted lg:text-body-lg lg:leading-[26px]">
                {bangla}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-5">{children}</div>
          <div className="fixed inset-x-0 bottom-0 z-10 flex items-center justify-between gap-3 border-t border-border-default bg-surface-card px-5 pt-4 pb-[max(16px,env(safe-area-inset-bottom))] lg:static lg:border-0 lg:bg-transparent lg:p-0">
            <button type="button" className="hidden items-center gap-1 text-body font-medium text-text-secondary hover:text-text-primary lg:inline-flex" onClick={() => navigate(back)}>
              <ChevronLeft aria-hidden className="size-4" /> Back
            </button>
            <span className="flex flex-1 items-center justify-end gap-2">{footer}</span>
          </div>
        </div>
      </div>
      {aside && (
        // Figma preview pane 50:700 / 52:661: 420 wide, brand-50, px 40 py 32, gap 20, 340 card.
        <aside className="hidden w-[420px] shrink-0 flex-col items-center gap-5 bg-brand-50 px-10 py-8 xl:flex">
          <div className="flex w-full items-center justify-between">
            <span className="flex items-center gap-2 text-caption font-medium text-brand-700">
              <span aria-hidden className="size-2 rounded-full bg-success" /> Checkout preview
            </span>
            <span className="text-caption text-text-muted">{asideNote}</span>
          </div>
          {aside}
        </aside>
      )}
    </div>
  );
}

/** Figma checkout preview card (50:802 / 52:732): 340 wide, card, border, radius 16, p 20, elevation 1. */
export const previewCardClass = 'flex w-[340px] flex-col rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1';

/** Figma checkout preview option (50:814): radius 10, px 14 py 12, 18 px radio; selected = brand-50 + 1.5 px brand border. */
export function PreviewOption({ selected, title, hint, trailing, onSelect }: { selected: boolean; title: string; hint: string; trailing?: ReactNode; onSelect?: () => void }) {
  const Tag = onSelect ? 'button' : 'div';
  return (
    <Tag
      {...(onSelect ? { type: 'button' as const, role: 'radio', 'aria-checked': selected, onClick: onSelect } : {})}
      className={
        selected
          ? 'flex w-full items-center gap-3 rounded-control border-[1.5px] border-brand-600 bg-brand-50 px-3.5 py-3 text-left'
          : 'flex w-full items-center gap-3 rounded-control border border-border-default bg-surface-card px-3.5 py-3 text-left'
      }
    >
      {selected ? (
        <span aria-hidden className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-brand-600">
          <span className="size-1.5 rounded-full bg-surface-card" />
        </span>
      ) : (
        <span aria-hidden className="size-[18px] shrink-0 rounded-full border-[1.5px] border-border-strong bg-surface-card" />
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-body font-medium text-text-primary">{title}</span>
        <span className="text-caption text-text-muted">{hint}</span>
      </span>
      {trailing}
    </Tag>
  );
}

export function OnboardingCard({ title, description, children, label }: { title: string; description?: string; children: ReactNode; label?: string }) {
  return (
    <section aria-label={label ?? title} className="flex flex-col gap-5 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1 lg:p-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-body-lg font-medium text-text-primary">{title}</h2>
        {description && <p className="text-body text-text-secondary">{description}</p>}
      </div>
      {children}
    </section>
  );
}
