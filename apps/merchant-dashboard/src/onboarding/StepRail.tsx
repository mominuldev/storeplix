import { Logo, ProgressBar, Step, type StepState } from '@storeplix/ui';
import { MessageCircle } from 'lucide-react';

// Figma 03 Name your shop 48:7869 step rail: 300 wide, surface-card, right border, px 24 py 32.
// Steps 2 (phone OTP) and 4–7 are later phases: shown as upcoming, never as done.
const steps: { title: string; hint: string; state: StepState }[] = [
  { title: 'Create account', hint: 'Phone & name', state: 'done' },
  { title: 'Verify phone', hint: 'Coming soon', state: 'upcoming' },
  { title: 'Name your shop', hint: 'Name, link & category', state: 'current' },
  { title: 'Pick a theme', hint: 'Look & brand colour', state: 'upcoming' },
  { title: 'Add products', hint: 'Your first items', state: 'upcoming' },
  { title: 'Delivery', hint: 'Zones & courier', state: 'upcoming' },
  { title: 'Get paid', hint: 'COD & gateways', state: 'upcoming' },
];

export function StepRail({ shopName }: { shopName: string }) {
  const done = steps.filter((s) => s.state === 'done').length;
  return (
    <aside className="hidden w-[300px] shrink-0 flex-col justify-between border-r border-border-default bg-surface-card px-6 py-8 lg:flex">
      <div className="flex flex-col gap-7">
        <Logo height={32} />
        <div className="flex flex-col gap-2.5">
          <h2 className="truncate text-heading text-text-primary">Set up {shopName || 'your shop'}</h2>
          <p className="text-caption text-text-secondary">
            {done} of {steps.length} done · about 5 min left
          </p>
          <ProgressBar value={done / steps.length} label="Setup progress" />
        </div>
        <ol className="flex flex-col gap-1">
          {steps.map((s, i) => (
            <li key={s.title}>
              <Step index={i + 1} title={s.title} hint={s.hint} state={s.state} />
            </li>
          ))}
        </ol>
      </div>
      <div className="flex flex-col gap-1.5 rounded-lg bg-surface-subtle p-4">
        <p className="flex items-center gap-2 text-body font-semibold text-text-primary">
          <MessageCircle aria-hidden className="size-[18px]" /> Stuck? We’ll help in Bangla
        </p>
        <p className="text-caption text-text-secondary">Call 09678-112233 or WhatsApp · 9am–9pm</p>
      </div>
    </aside>
  );
}
