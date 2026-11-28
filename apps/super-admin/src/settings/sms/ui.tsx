import { Button, cn, Input, Modal } from '@storeplix/ui';
import { AlertTriangle, CheckCircle2, Lock } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { LoggedAs } from '../../components/LoggedAs';
import { normalizeBdPhone, testPhoneMemory } from './format';
import { smsErrorText } from './queries';

// Shared pieces of the /settings/sms screens. Card = Figma "Card/SMS gateway" 2099:9000: surface-card, border,
// radius 16, Elevation/1, pt 20 pb 24 px 24, gap 20; header Body/16 Medium title + Caption muted subtitle.
export function SectionCard({
  title,
  description,
  actions,
  children,
  className,
  dashed,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  dashed?: boolean;
}) {
  return (
    <section
      className={cn(
        'flex min-w-0 flex-col gap-5 rounded-card border bg-surface-card px-4 pt-5 pb-6 shadow-elevation-1 sm:px-6',
        dashed ? 'border-dashed border-border-strong' : 'border-border-default',
        className,
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-body-lg font-medium text-text-primary">{title}</h2>
          {description && <p className="text-caption text-text-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** Section header inside a card (2099:9036): Body/14 Medium + Caption muted. */
export function SubHeader({ title, description }: { title: ReactNode; description?: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <h3 className="text-body font-medium text-text-primary">{title}</h3>
      {description && <p className="text-caption text-text-muted">{description}</p>}
    </div>
  );
}

/** Summary rows (activate / confirm dialogs 2114:10581, 2103:9134): subtle panel, label left, value right. */
export function SummaryList({ title, rows }: { title?: ReactNode; rows: { label: ReactNode; value: ReactNode; tone?: 'warning' | 'muted' }[] }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-surface-subtle px-4 py-3.5">
      {title && <p className="text-body font-medium text-text-primary">{title}</p>}
      <dl className="flex flex-col gap-2">
        {rows.map((r, i) => (
          <div key={i} className="flex items-start justify-between gap-4 text-body">
            <dt className="shrink-0 text-text-secondary">{r.label}</dt>
            <dd className={cn('text-right font-medium', r.tone === 'warning' ? 'text-warning' : r.tone === 'muted' ? 'text-text-secondary' : 'text-text-primary')}>{r.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Locked write-only field (2099:9047): lock icon + `••••3f9a` + optional action. Secrets are never shown. */
export function LockedField({ label, hint, value, action, caption }: { label: string; hint?: string | null; value?: string; action?: ReactNode; caption?: ReactNode }) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <span id={id} className="text-body font-medium text-text-primary">
        {label}
      </span>
      <div aria-labelledby={id} className="flex min-h-10 items-center gap-2 rounded-md border border-border-default bg-surface-subtle px-3 py-1">
        <Lock aria-hidden className="size-3.5 shrink-0 text-text-muted" />
        <span className="min-w-0 flex-1 truncate font-mono text-body text-text-primary">{value ?? (hint ? `••••••••••••${hint.replace(/^•+/, '')}` : '••••••••••••')}</span>
        {action}
      </div>
      {caption && <p className="text-caption text-text-muted">{caption}</p>}
    </div>
  );
}

export function ReadOnlyField({ label, value, caption }: { label: string; value: ReactNode; caption?: ReactNode }) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <span id={id} className="text-body font-medium text-text-primary">
        {label}
      </span>
      <div aria-labelledby={id} className="flex min-h-10 items-center rounded-md border border-border-default bg-surface-card px-3 py-2 text-body break-all text-text-primary">
        {value || '—'}
      </div>
      {caption && <p className="text-caption text-text-muted">{caption}</p>}
    </div>
  );
}

export function InlineAlert({ tone, children, action }: { tone: 'danger' | 'warning' | 'info' | 'success'; children: ReactNode; action?: ReactNode }) {
  const Icon = tone === 'success' ? CheckCircle2 : AlertTriangle;
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'flex flex-wrap items-start gap-2.5 rounded-[10px] px-3.5 py-3 text-body text-text-primary',
        tone === 'danger' && 'bg-danger-bg',
        tone === 'warning' && 'bg-warning-bg',
        tone === 'info' && 'bg-info-bg',
        tone === 'success' && 'bg-success-bg',
      )}
    >
      <Icon
        aria-hidden
        className={cn('mt-0.5 size-4 shrink-0', tone === 'danger' && 'text-danger', tone === 'warning' && 'text-warning', tone === 'info' && 'text-info', tone === 'success' && 'text-success')}
      />
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}

/** BD mobile input (+880 prefix) with client normalisation; `error` from the parent wins. */
export function PhoneField({ value, onChange, error, label = 'Send a test SMS to', hint }: { value: string; onChange: (v: string) => void; error?: string | null; label?: string; hint?: string }) {
  return (
    <Input
      label={label}
      inputMode="tel"
      autoComplete="tel"
      placeholder="01XXXXXXXXX"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      error={error ?? undefined}
      hint={hint ?? 'Any Bangladesh mobile number. Test SMS are limited to 10 an hour.'}
    />
  );
}

/**
 * "Send test SMS / Send test to me" dialog (P89B-26): staff type a phone (pre-filled with the last one used),
 * the send is synchronous; the result (or error) shows in place.
 */
export function TestSmsDialog<T>({
  title,
  description,
  onClose,
  send,
  renderResult,
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  send: (phone: string) => Promise<T>;
  renderResult: (result: T) => ReactNode;
}) {
  const [phone, setPhone] = useState(testPhoneMemory.get());
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<T | null>(null);
  const formId = useId();

  const submit = async () => {
    const normalized = normalizeBdPhone(phone);
    if (!normalized) {
      setError('Enter a Bangladesh mobile number, e.g. 01711555211.');
      return;
    }
    setError(null);
    setPending(true);
    testPhoneMemory.set(phone);
    try {
      setResult(await send(normalized));
    } catch (e) {
      setError(smsErrorText(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      footerStart={<LoggedAs />}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            {result ? 'Close' : 'Cancel'}
          </Button>
          <Button type="submit" form={formId} loading={pending}>
            {result ? 'Send again' : 'Send test'}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <PhoneField value={phone} onChange={setPhone} error={error} />
        {result && renderResult(result)}
      </form>
    </Modal>
  );
}
