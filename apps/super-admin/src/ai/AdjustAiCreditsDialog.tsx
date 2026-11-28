import { isApiError } from '@storeplix/api-client';
import type { AdminAiCredits } from '@storeplix/types';
import { ChoiceCard, Dialog, Input, cn } from '@storeplix/ui';
import { useMutation } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { useId, useState } from 'react';
import { LoggedAs } from '../components/LoggedAs';
import { ReasonField } from '../components/ReasonField';
import { reasonSchema } from '../components/reason';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { newIdempotencyKey } from '../lib/ids';
import { AI_CREDIT_ADJUST_MAX, aiAdjustPreview, aiAdjustReasons, fmt, signed, type AdjustMode } from './format';

// Dialog · Adjust AI credits (PHASE-8-9D §10.4, P89D-35, `manage_billing`). No Figma frame: composed from the 8.9a
// Adjust SMS credits dialog 2095:8345 — Grant / Deduct option cards, Credits (1–100,000), reason presets that fill the
// Reason (5–500, shown to the merchant on their AI credit history and saved to the audit log), "After this change"
// preview (bonus credits change; the plan's monthly allowance isn't touched), footer "Logged as … · saved to the audit
// log" + Cancel / Apply. One Idempotency-Key per dialog open (reused on retry); 422 `ai_credits_insufficient` inline.
export function AdjustAiCreditsDialog({
  tenantId,
  shopLabel,
  credits,
  onClose,
  onDone,
}: {
  tenantId: string;
  /** "Gadget Haat · Starter plan" */
  shopLabel: string;
  credits: AdminAiCredits;
  onClose: () => void;
  onDone: (updated: AdminAiCredits, delta: number) => void;
}) {
  const formId = useId();
  const [key] = useState(newIdempotencyKey);
  const [mode, setMode] = useState<AdjustMode>('grant');
  const [amount, setAmount] = useState('');
  const [preset, setPreset] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<{ amount?: string; reason?: string }>({});
  const bonus = credits.credits.bonus;
  const preview = aiAdjustPreview(bonus, mode, amount);
  const mutation = useMutation({
    mutationFn: (input: { credits: number; reason: string }) => api.admin.aiCredits.adjust(tenantId, input, key),
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

  const insufficient = isApiError(mutation.error) && mutation.error.code === 'ai_credits_insufficient';
  const deduct = mode === 'deduct';
  const belowZero = deduct && preview.after < 0;
  const availableAfter = credits.credits.available + preview.delta;

  return (
    <Dialog
      open
      title="Adjust AI credits"
      description={`${shopLabel}. This changes bonus credits only — the plan’s monthly AI allowance isn’t touched.`}
      icon={<Sparkles />}
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
              detail="Add bonus credits (never expire)"
            />
            <ChoiceCard
              name={`${formId}-mode`}
              value="deduct"
              checked={deduct}
              onChange={() => setMode('deduct')}
              title="Deduct credits"
              detail="Remove from bonus credits"
            />
          </div>
        </fieldset>

        <Input
          label={deduct ? 'Credits to deduct' : 'Credits to grant'}
          inputMode="numeric"
          autoComplete="off"
          placeholder="100"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            if (errors.amount) setErrors((x) => ({ ...x, amount: undefined }));
          }}
          trailing={<span className="text-body text-text-muted">credits</span>}
          error={errors.amount ?? (belowZero ? preview.error ?? undefined : undefined)}
          hint={`Whole number from 1 to ${fmt(AI_CREDIT_ADJUST_MAX)}. 1 credit = 1 product description; a photo edit costs ${credits.credits.costs.photo_edit}.`}
        />

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-body font-semibold text-text-primary">Reason · required</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {aiAdjustReasons.map((p) => (
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
            hint="Shown in the shop’s AI credit history and saved to the audit log with your name."
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
            <span className="min-w-0 flex-1 font-medium text-text-secondary">Bonus credits</span>
            {preview.delta !== 0 && (
              <span data-testid="ai-adjust-delta" className={cn('text-caption tabular-nums', preview.delta > 0 ? 'text-success' : 'text-danger')}>
                {signed(preview.delta)}
              </span>
            )}
            <span className={cn('font-medium whitespace-nowrap tabular-nums', belowZero ? 'text-danger' : 'text-text-primary')}>
              {fmt(bonus)} → {fmt(preview.after)}
            </span>
          </div>
          <div className="flex items-center gap-2 text-body">
            <span className="min-w-0 flex-1 font-medium text-text-secondary">Available now</span>
            <span className="font-medium whitespace-nowrap text-text-primary tabular-nums">
              {fmt(credits.credits.available)} → {fmt(Math.max(0, availableAfter))}
            </span>
          </div>
          <div className="flex items-center gap-2 text-body">
            <span className="min-w-0 flex-1 font-medium text-text-secondary">Plan allowance this month</span>
            <span className="text-caption text-text-muted">Not changed</span>
          </div>
        </section>

        {mutation.isError && (
          <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-body text-danger">
            {insufficient ? `Can’t go below 0 — the shop has ${fmt(bonus)} bonus credits. Refresh and try a smaller number.` : errorMessage(mutation.error)}
          </p>
        )}
      </form>
    </Dialog>
  );
}
