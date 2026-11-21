import { Logo } from '@storeplix/ui';
import { CheckCircle2 } from 'lucide-react';
import type { ReactNode } from 'react';

// Figma Merchant Onboarding (43:13544), desktop auth row: split screen — brand-600 panel (~38%)
// with logo, eyebrow, headline and benefits; white form panel. Collapses to form-only on mobile.
export function AuthLayout({
  headline,
  points,
  children,
}: {
  headline: ReactNode;
  points: string[];
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh bg-surface-card">
      <aside className="hidden w-[38%] max-w-[560px] flex-col gap-10 bg-brand-600 p-10 text-text-inverse lg:flex">
        <Logo tone="white" height={32} />
        <div className="flex flex-col gap-6">
          <p className="text-caption font-medium tracking-[0.06em] uppercase opacity-80">For Bangladeshi online sellers</p>
          <h1 className="text-display">{headline}</h1>
          <ul className="flex flex-col gap-3">
            {points.map((p) => (
              <li key={p} className="flex items-start gap-3 text-body-lg">
                <CheckCircle2 className="mt-0.5 size-5 shrink-0 opacity-90" aria-hidden />
                {p}
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <main className="flex flex-1 flex-col px-4 py-8 sm:px-10">
        <div className="lg:hidden">
          <Logo height={28} />
        </div>
        <div className="flex flex-1 items-center justify-center py-8">
          <div className="w-full max-w-[400px]">{children}</div>
        </div>
      </main>
    </div>
  );
}
