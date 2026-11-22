import { Logo, ProgressBar, Step, type StepState } from '@storeplix/ui';
import { MessageCircle } from 'lucide-react';

// Figma 03 Name your shop 48:7869 step rail: 300 wide, surface-card, right border, px 24 py 32.
// Step 2 is done once the phone is verified; steps before `current` are done (Phase 5a: 6 Delivery, 7 Get paid).
const baseSteps: { title: string; hint: string }[] = [
  { title: 'Create account', hint: 'Phone & name' },
  { title: 'Verify phone', hint: 'Coming soon' },
  { title: 'Name your shop', hint: 'Name, link & category' },
  { title: 'Pick a theme', hint: 'Look & brand colour' },
  { title: 'Add products', hint: 'Your first items' },
  { title: 'Delivery', hint: 'Zones & courier' },
  { title: 'Get paid', hint: 'COD & gateways' },
];

/** `current` = 1-based step number (3 Name your shop … 6 Delivery, 7 Get paid). */
export function StepRail({ shopName, current = 3, phoneVerified = false }: { shopName: string; current?: 3 | 4 | 5 | 6 | 7; phoneVerified?: boolean }) {
  const steps = baseSteps.map((s, i): { title: string; hint: string; state: StepState } => {
    const n = i + 1;
    const done = n === 1 || (n === 2 && phoneVerified) || (n >= 3 && n < current);
    return { ...s, hint: n === 2 && phoneVerified ? '6-digit code' : s.hint, state: n === current ? 'current' : done ? 'done' : 'upcoming' };
  });
  const done = steps.filter((s) => s.state === 'done').length;
  return (
    <aside className="hidden w-[300px] shrink-0 flex-col justify-between border-r border-border-default bg-surface-card px-6 py-8 lg:flex">
      <div className="flex flex-col gap-7">
        <Logo height={32} />
        <div className="flex flex-col gap-2.5">
          <h2 className="truncate text-heading text-text-primary">Set up {shopName || 'your shop'}</h2>
          <p className="text-caption text-text-secondary">
            {done} of {steps.length} done · about {Math.max(1, (steps.length - done) * 1)} min left
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
