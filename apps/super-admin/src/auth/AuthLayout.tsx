import { Logo } from '@storeplix/ui';
import { Shield } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { useHealth } from '../lib/health';

// Brand panel 44:4708 fill: coral radial glow (top-left, 28%) + white→navy sheen (131.6°) over brand-600.
// The navy stop (#1f1473 @ 35%) has no token; brand-700 mixed into text-primary is the closest token blend.
const brandPanel: CSSProperties = {
  backgroundImage: [
    'radial-gradient(250px 375px at 125px 37.5px, color-mix(in srgb, var(--color-accent-500) 28%, transparent), transparent)',
    'linear-gradient(131.6deg, color-mix(in srgb, var(--color-text-inverse) 16%, transparent) 14.3%, transparent 53.6%, color-mix(in srgb, color-mix(in srgb, var(--color-brand-700) 45%, var(--color-text-primary)) 35%, transparent) 85.7%)',
  ].join(', '),
};

// Figma Platform Admin · Sign in 44:4707 / 2FA 44:4784 — 600px brand panel (px 64 py 56, space-between: wordmark,
// pitch, security note; the uptime/GMV/tickets stats are hidden in 8.1) + white form side (400px column, gap 24;
// footer 48px from the bottom).
export function AuthLayout({ children }: { children: ReactNode }) {
  const health = useHealth();
  return (
    <div className="flex min-h-dvh bg-surface-card">
      <aside
        style={brandPanel}
        className="sticky top-0 hidden h-dvh min-h-[720px] w-[600px] shrink-0 flex-col justify-between overflow-hidden bg-brand-600 px-16 py-14 text-text-inverse lg:flex"
      >
        <div className="flex flex-col gap-1.5">
          <Logo tone="inverse" height={28} />
          <span className="text-caption font-medium opacity-72">Platform admin</span>
        </div>
        <div className="flex flex-col gap-5">
          <p className="text-caption font-medium tracking-[0.96px] uppercase opacity-70">Internal console</p>
          <p className="text-display">Keep every Bangladeshi shop selling, every hour of the day.</p>
          <p className="text-body-lg opacity-80">Billing, domains and support for every Storeplix merchant, in one place.</p>
        </div>
        <div className="flex items-center gap-3.5 rounded-[14px] border border-white/16 bg-text-primary/22 px-[18px] py-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-white/14">
            <Shield className="size-5" aria-hidden />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-body font-semibold">Staff access only · every action is audited</span>
            <span className="text-caption opacity-75">Sign-ins, impersonation and billing changes are logged with your name, IP and reason.</span>
          </span>
        </div>
      </aside>
      <main className="relative flex min-w-0 flex-1 flex-col items-center justify-center px-4 pt-10 pb-24 lg:px-20">
        <div className="flex w-full max-w-[420px] flex-col gap-6">
          <div className="lg:hidden">
            <Logo height={28} />
          </div>
          {children}
        </div>
        <p className="absolute bottom-8 left-4 flex flex-wrap items-center gap-1.5 text-caption text-text-muted lg:left-20">
          <span>Trouble signing in? Ask in #platform-oncall</span>
          {health.data && (
            <>
              <span aria-hidden>·</span>
              <span>v{health.data.version}</span>
            </>
          )}
        </p>
      </main>
    </div>
  );
}

/** 52px brand-50 tile with the shield (2FA 44:4784 header). */
export function ShieldTile() {
  return (
    <span aria-hidden className="flex size-[52px] items-center justify-center rounded-lg bg-brand-50 text-brand-600">
      <Shield className="size-6" />
    </span>
  );
}

export function FormAlert({ tone = 'danger', title, children }: { tone?: 'danger' | 'warning' | 'info'; title?: ReactNode; children?: ReactNode }) {
  const cls = tone === 'danger' ? 'bg-danger-bg text-danger' : tone === 'warning' ? 'bg-warning-bg text-warning' : 'bg-info-bg text-info';
  return (
    <div role={tone === 'info' ? 'status' : 'alert'} className={`flex flex-col gap-0.5 rounded-lg px-4 py-3 ${cls}`}>
      {title && <p className="text-body font-semibold">{title}</p>}
      {children && <p className={title ? 'text-caption text-text-secondary' : 'text-body'}>{children}</p>}
    </div>
  );
}
