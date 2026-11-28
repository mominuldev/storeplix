import { isApiError } from '@storeplix/api-client';
import type { AdminSmsCredits } from '@storeplix/types';
import { ChoiceCard, Dialog, Input, cn } from '@storeplix/ui';
import { useMutation } from '@tanstack/react-query';
import { MessageCircle } from 'lucide-react';
import { useId, useState } from 'react';
import { LoggedAs } from '../components/LoggedAs';
import { ReasonField } from '../components/ReasonField';
import { reasonSchema } from '../components/reason';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { newIdempotencyKey } from '../lib/ids';
import { adjustPreview, adjustReasons, signed, type AdjustMode } from './format';

const fmt = (n: number) => n.toLocaleString('en-IN');

// Dialog · Adjust SMS credits 2095:8345 (PHASE-8-9A §13.2, P89A-18, `manage_billing`), on the Suspend dialog pattern:
// Grant / Deduct option cards, Credits (1–1,000,000, contract range), reason presets that fill the Reason (5–500,
// shown to the merchant on their credit ledger — the API stores one reason, so the Figma "Note for the audit log" is
// folded into it), "After this change" preview, footer "Logged as … · saved to the audit log" + Cancel / Apply.
// Deduct (composed, no frame): "Credits to deduct", red delta, "Can’t go below 0 …" error and Apply disabled.
// One Idempotency-Key per dialog open (reused on retry); 422 `sms_credits_insufficient` inline.
export function AdjustSmsCreditsDialog({
  tenantId,
  shopLabel,
  credits,
  onClose,
  onDone,
}: {
  tenantId: string;
  /** "Gadget Haat · Starter plan" */
  shopLabel: string;
  credits: AdminSmsCredits;
  onClose: () => void;
  onDone: (updated: AdminSmsCredits, delta: number) => void;
}) {
  const formId = useId();
  const [key] = useState(newIdempotencyKey);
  const [mode, setMode] = useState<AdjustMode>('grant');
  const [amount, setAmount] = useState('');
  const [preset, setPreset] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<{ amount?: string; reason?: string }>({});
  const preview = adjustPreview(credits.balance, mode, amount);
  const mutation = useMutation({
    mutationFn: (input: { credits: number; reason: string }) => api.admin.smsCredits.adjust(tenantId, input, key),
    onSuccess: (updated, input) => onDone(updated, input.credits),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (amount.trim() === '') next.amount = 'Enter the number of credits.';
    else if (preview.error) next.amount = preview.error;
    const r = reasonSchema.safeParse(reason);
    if (!r.success) next.reason = r.error.issues[0]?.message;
    setErrors(next);
    if (next.amount || next.reason || !r.success) return;
    mutation.mutate({ credits: preview.delta, reason: r.data });
  };

  const insufficient = isApiError(mutation.error) && mutation.error.code === 'sms_credits_insufficient';
  const deduct = mode === 'deduct';
  const belowZero = deduct && preview.after < 0;

  return (
    <Dialog
      open
      title="Adjust SMS credits"
      description={`${shopLabel}. This changes purchased credits only — the plan’s monthly SMS allowance isn’t touched.`}
      icon={<MessageCircle />}
      iconClassName="bg-brand-50 text-brand-600"
      confirmLabel="Apply"
      formId={formId}
      loading={mutation.isPending}
      confirmDisabled={belowZero}
      footerStart={<LoggedAs suffix="saved to the audit log" />}
      size="lg"
      onConfirm={() => undefined}
      onCancel={onClose}
    >
      <form id={formId} noValidate onSubmit={submit} className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-body font-semibold text-text-primary">Action</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            <ChoiceCard
              name={`${formId}-mode`}
              value="grant"
              checked={mode === 'grant'}
              onChange={() => setMode('grant')}
              title="Grant credits"
              detail="Add to purchased credits"
            />
            <ChoiceCard
              name={`${formId}-mode`}
              value="deduct"
              checked={deduct}
              onChange={() => setMode('deduct')}
              title="Deduct credits"
              detail="Remove from purchased credits"
            />
          </div>
        </fieldset>

        <Input
          label={deduct ? 'Credits to deduct' : 'Credits to grant'}
          inputMode="numeric"
          autoComplete="off"
          placeholder="500"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            if (errors.amount) setErrors((x) => ({ ...x, amount: undefined }));
          }}
          trailing={<span className="text-body text-text-muted">credits</span>}
          error={errors.amount ?? (belowZero ? preview.error ?? undefined : undefined)}
          hint="Whole number from 1 to 1,000,000. 1 credit = 1 SMS part."
        />

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-body font-semibold text-text-primary">Reason · required</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {adjustReasons.map((p) => (
              <ChoiceCard
                key={p.key}
                name={`${formId}-preset`}
                value={p.key}
                checked={preset === p.key}
                onChange={() => {
                  setPreset(p.key);
                  setReason(p.text);
                  setErrors((x) => ({ ...x, reason: undefined }));
                }}
                title={p.label}
                detail={p.hint}
              />
            ))}
          </div>
          <ReasonField
            label="Reason shown to the merchant"
            hint="Shown in the shop’s credit history and saved to the audit log with your name."
            value={reason}
            error={errors.reason}
            onChange={(e) => {
              setReason(e.target.value);
              if (errors.reason) setErrors((x) => ({ ...x, reason: undefined }));
            }}
          />
        </fieldset>

        <section aria-label="After this change" className="flex flex-col gap-2.5 rounded-lg border border-border-default bg-surface-subtle px-4 py-3.5">
          <h3 className="text-body font-semibold text-text-primary">After this change</h3>
          <div className="flex items-center gap-2 text-body">
            <span className="min-w-0 flex-1 font-medium text-text-secondary">Purchased credits</span>
            {preview.delta !== 0 && (
              <span data-testid="adjust-delta" className={cn('text-caption tabular-nums', preview.delta > 0 ? 'text-success' : 'text-danger')}>
                {signed(preview.delta)}
              </span>
            )}
            <span className={cn('font-medium whitespace-nowrap tabular-nums', belowZero ? 'text-danger' : 'text-text-primary')}>
              {fmt(credits.balance)} → {fmt(preview.after)}
            </span>
          </div>
          <div className="flex items-center gap-2 text-body">
            <span className="min-w-0 flex-1 font-medium text-text-secondary">Plan allowance this month</span>
            <span className="text-caption text-text-muted">Not changed</span>
          </div>
        </section>

        {mutation.isError && (
          <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-body text-danger">
            {insufficient ? `Can’t go below 0 — the shop has ${fmt(credits.balance)} purchased credits. Refresh and try a smaller number.` : errorMessage(mutation.error)}
          </p>
        )}
      </form>
    </Dialog>
  );
}
