import { Icon } from '../components/icon';

export interface TimelineStep {
  key: string;
  title: string;
  detail?: string;
  state: 'done' | 'current' | 'todo' | 'stopped';
}

/** Vertical status timeline (Figma thank-you 1:11788 and track 1:11959). */
export function OrderTimeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <ol className="flex flex-col">
      {steps.map((s, i) => (
        <li key={s.key} className="relative flex gap-4 pb-6 last:pb-0" data-sp-step={s.state}>
          {i < steps.length - 1 ? (
            <span aria-hidden className={`absolute top-7 bottom-0 left-[13px] w-0.5 ${s.state === 'done' ? 'bg-brand' : 'bg-line'}`} />
          ) : null}
          <span
            aria-hidden
            className={`relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full ${
              s.state === 'done' ? 'bg-brand text-on-brand' : s.state === 'current' ? 'bg-orange text-[#0e1a33]' : s.state === 'stopped' ? 'bg-sale text-paper' : 'border-2 border-line bg-surface'
            }`}
          >
            {s.state === 'done' ? <Icon name="check" size={14} /> : s.state === 'current' ? <Icon name="truck-sm" size={14} /> : s.state === 'stopped' ? <Icon name="x" size={14} /> : null}
          </span>
          <div className="flex min-w-0 flex-col gap-0.5 pt-0.5">
            <p className={`type-label-m ${s.state === 'todo' ? 'text-ink-muted' : 'text-ink'}`}>
              {s.title}
              <span className="sr-only">{s.state === 'done' ? ' (done)' : s.state === 'current' ? ' (in progress)' : ''}</span>
            </p>
            {s.detail ? <p className="type-body-s text-ink-muted">{s.detail}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
