import { isApiError } from '@storeplix/api-client';
import { FRAUD_GUARD_NOTE_MAX, type NumberCheck, type RiskTier } from '@storeplix/types';
import { Button, cn, Input, Modal, riskTierMeta } from '@storeplix/ui';
import { useState } from 'react';
import { errorMessage } from '../catalog/states';
import { localPhone } from '../commerce/format';
import { normalizeBdPhone } from '../lib/phone';
import { toast } from '../online-store/components/Toast';
import { longDate, noteError, phoneError } from './fraud';
import { useBlockMutations, useCheckNumber } from './queries';

// PHASE-8-8 §10.1 composed dialogs (no Figma frames): "Check a number" (phone → NumberCheck result card styled as
// 29:3104, own-shop record only) and "Block a number" (phone + note). Errors per §8.4: 409 `already_blocked`,
// 402 `feature_not_in_plan`, 429 limiter `fraud-check`.

const cardTone: Record<RiskTier, { box: string; text: string }> = {
  risky: { box: 'bg-danger-bg', text: 'text-danger' },
  careful: { box: 'bg-warning-bg', text: 'text-warning' },
  good: { box: 'bg-success-bg', text: 'text-success' },
  new: { box: 'bg-surface-subtle', text: 'text-text-secondary' },
};

/** NumberCheck result card (29:3104 style): big rate, tier pill, own-shop counts, last return / blocked line. */
export function NumberCheckCard({ result, onBlock }: { result: NumberCheck; onBlock?: () => void }) {
  const tone = cardTone[result.tier];
  const returned = result.total - result.delivered;
  return (
    <section aria-label="Check result" className={cn('flex gap-5 rounded-[14px] px-5 py-[18px]', tone.box)}>
      <div className={cn('flex shrink-0 flex-col items-center', tone.text)}>
        <span className="text-display font-bold">{result.rate === null ? '—' : `${result.rate}%`}</span>
        <span className="text-caption">delivered</span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body-lg font-medium text-text-primary">{result.phone_masked}</span>
          <span className={cn('rounded-full bg-surface-card px-2 py-0.5 text-caption font-medium', tone.text)}>{riskTierMeta[result.tier].label}</span>
        </div>
        <p className="text-body text-text-primary">
          {result.total === 0 ? 'No parcels at your shop yet' : `${result.total} ${result.total === 1 ? 'parcel' : 'parcels'} at your shop · ${result.delivered} delivered · ${returned} returned`}
        </p>
        <p className="text-caption text-text-secondary">
          {[result.last_return_on ? `Last return ${longDate(result.last_return_on).replace(/ \d{4}$/, '')}` : null, result.blocked ? 'Blocked — cash on delivery is off for this number' : null].filter(Boolean).join(' · ') ||
            'Only your shop’s own orders are checked.'}
        </p>
        {onBlock && !result.blocked && (
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" className="px-0" onClick={onBlock}>
              Block number
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

export function CheckNumberDialog({ onClose, onBlock }: { onClose: () => void; onBlock: (phone: string) => void }) {
  const [phone, setPhone] = useState('');
  const [touched, setTouched] = useState(false);
  const check = useCheckNumber();
  const invalid = phoneError(phone);
  const submit = () => {
    setTouched(true);
    if (invalid) return;
    check.mutate(normalizeBdPhone(phone)!);
  };
  const apiError = check.error
    ? isApiError(check.error) && check.error.status === 429
      ? 'You’ve checked a lot of numbers. Wait a minute and try again.'
      : isApiError(check.error) && check.error.code === 'feature_not_in_plan'
        ? 'Fake order guard is on Starter and Growth.'
        : isApiError(check.error) && check.error.status === 422
          ? (check.error.fieldError('phone') ?? check.error.message)
          : errorMessage(check.error, 'We couldn’t check this number.')
    : null;
  return (
    <Modal
      open
      onClose={onClose}
      title="Check a number"
      description="See how this number’s orders went at your shop before you confirm."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button type="submit" form="check-number-form" loading={check.isPending}>
            Check
          </Button>
        </>
      }
    >
      <form
        id="check-number-form"
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input
          id="check-phone"
          label="Phone number"
          inputMode="tel"
          autoComplete="off"
          placeholder="01712-345678"
          value={phone}
          onChange={(e) => {
            setPhone(e.target.value);
            check.reset();
          }}
          error={touched ? (invalid ?? apiError ?? undefined) : (apiError ?? undefined)}
        />
        {check.data && <NumberCheckCard result={check.data} onBlock={() => onBlock(normalizeBdPhone(phone) ?? phone)} />}
      </form>
    </Modal>
  );
}

export function BlockNumberDialog({ initialPhone = '', onClose }: { initialPhone?: string; onClose: () => void }) {
  const [phone, setPhone] = useState(localPhone(initialPhone));
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { block } = useBlockMutations();
  const pErr = phoneError(phone);
  const nErr = noteError(note);
  const submit = () => {
    setTouched(true);
    setError(null);
    if (pErr || nErr) return;
    block.mutate(
      { phone: normalizeBdPhone(phone)!, note: note.trim() || null },
      {
        onSuccess: (entry) => {
          toast(
            entry.open_orders_count > 0
              ? `${entry.phone_masked} blocked. ${entry.open_orders_count} open ${entry.open_orders_count === 1 ? 'order' : 'orders'} from this number ${entry.open_orders_count === 1 ? 'is' : 'are'} not cancelled — check ${entry.open_orders_count === 1 ? 'it' : 'them'}.`
              : `${entry.phone_masked} blocked. Cash on delivery is off for this number.`,
          );
          onClose();
        },
        onError: (e) => {
          if (isApiError(e) && e.code === 'already_blocked') return setError('This number is already blocked.');
          if (isApiError(e) && e.code === 'feature_not_in_plan') return setError('Fake order guard is on Starter and Growth.');
          if (isApiError(e) && e.status === 422) return setError(e.fieldError('phone') ?? e.fieldError('note') ?? e.message);
          setError(errorMessage(e, 'We couldn’t block this number.'));
        },
      },
    );
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="Block a number"
      description="Cash on delivery is turned off for this number. They can still pay online."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={block.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="block-number-form" variant="danger" loading={block.isPending}>
            Block number
          </Button>
        </>
      }
    >
      <form
        id="block-number-form"
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input id="block-phone" label="Phone number" inputMode="tel" autoComplete="off" placeholder="01712-345678" value={phone} onChange={(e) => setPhone(e.target.value)} error={touched ? (pErr ?? undefined) : undefined} />
        <Input
          id="block-note"
          label="Reason (optional)"
          placeholder="Fake name and address"
          maxLength={FRAUD_GUARD_NOTE_MAX + 20}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          error={touched || note.length > FRAUD_GUARD_NOTE_MAX ? (nErr ?? undefined) : undefined}
          hint="Only your team sees this."
        />
        {error && (
          <p role="alert" className="text-caption text-danger">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
