import { zodResolver } from '@hookform/resolvers/zod';
import type { AdminPlanChangeEffective, AdminTenant, BillingInterval, Plan, Subscription, SuspensionReasonCode } from '@storeplix/types';
import { Checkbox, Chip, Dialog, Input, SegmentedControl, Skeleton, Toggle, cn } from '@storeplix/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Check, CreditCard, LayoutDashboard, Store } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { LoggedAs } from '../components/LoggedAs';
import { ReasonField } from '../components/ReasonField';
import { reasonSchema } from '../components/reason';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { formatDate, intervalLabel, money } from '../lib/format';
import { newIdempotencyKey } from '../lib/ids';

function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-body text-danger">
      {errorMessage(error)}
    </p>
  );
}

/** Radio card (45:4989 plan / effective cards, 45:8866 reason cards): 1px border-default, selected 2px brand. */
function RadioCard({
  checked,
  onSelect,
  title,
  hint,
  tone = 'brand',
  badge,
  children,
}: {
  checked: boolean;
  onSelect: () => void;
  title: ReactNode;
  hint?: ReactNode;
  tone?: 'brand' | 'danger';
  badge?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={cn(
        'flex min-w-0 flex-col gap-1 rounded-lg border px-4 py-3 text-left outline-none focus-visible:shadow-focus',
        checked
          ? tone === 'danger'
            ? 'border-danger bg-danger-bg shadow-[inset_0_0_0_1px_var(--color-danger)]'
            : 'border-brand-600 bg-brand-50 shadow-[inset_0_0_0_1px_var(--color-brand-600)]'
          : 'border-border-default bg-surface-card hover:bg-surface-subtle',
      )}
    >
      <span className="flex items-center gap-2.5">
        <span
          aria-hidden
          className={cn(
            'size-[18px] shrink-0 rounded-full border-2',
            checked ? (tone === 'danger' ? 'border-[5px] border-danger' : 'border-[5px] border-brand-600') : 'border-border-strong',
          )}
        />
        <span className="min-w-0 flex-1 text-body font-medium text-text-primary">{title}</span>
        {badge}
      </span>
      {hint && <span className="pl-7 text-caption text-text-muted">{hint}</span>}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- Change plan (45:4989, P8-13)

const changePlanSchema = z.object({
  plan_code: z.string().min(1, 'Choose a plan'),
  interval: z.enum(['month', 'year']),
  effective: z.enum(['now', 'next_renewal']),
  notify: z.boolean(),
  reason: reasonSchema,
});
type ChangePlanValues = z.infer<typeof changePlanSchema>;

const planPrice = (p: Plan, interval: BillingInterval) => (interval === 'year' ? p.price_yearly_amount : p.price_amount);

// "Now" is a comp change (no invoice, open invoice voided, period kept) and "At next renewal" writes the scheduled
// change; the quote's warnings show what the new limits would break. "Charge today" / proration preview are out (Q95).
export function ChangePlanDialog({ tenant, onClose, onDone }: { tenant: AdminTenant; onClose: () => void; onDone: (s: Subscription) => void }) {
  const formId = useId();
  const [key] = useState(newIdempotencyKey);
  const sub = tenant.subscription;
  const plans = useQuery({
    queryKey: ['plans'],
    queryFn: () => api.plans.list(),
    staleTime: 10 * 60_000,
  });
  const { control, register, handleSubmit, watch, formState } = useForm<ChangePlanValues>({
    resolver: zodResolver(changePlanSchema),
    defaultValues: {
      plan_code: '',
      interval: tenant.billing_interval ?? 'month',
      effective: 'now',
      notify: true,
      reason: '',
    },
  });
  const [planCode, interval, effective] = watch(['plan_code', 'interval', 'effective']);
  const unchanged = planCode === tenant.plan_code && interval === (tenant.billing_interval ?? 'month');

  const quote = useQuery({
    queryKey: ['admin', 'quote', tenant.id, planCode, interval, effective],
    queryFn: () =>
      api.admin.tenants.quote(tenant.id, {
        plan_code: planCode,
        interval,
        effective,
      }),
    enabled: !!planCode && !unchanged,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: (v: ChangePlanValues) => api.admin.tenants.changePlan(tenant.id, { ...v, reason: v.reason.trim() }, key),
    onSuccess: onDone,
  });

  const renewal = sub?.current_period_end ?? sub?.trial_ends_at ?? null;
  const current = sub
    ? `Currently ${sub.plan.name} · ${intervalLabel(sub.billing_interval).toLowerCase()}${renewal ? ` · renews ${formatDate(renewal)}` : ''}`
    : `Currently ${tenant.plan_code}`;

  return (
    <Dialog
      open
      title={`Change plan · ${tenant.name}`}
      description={current}
      size="xl"
      confirmLabel="Confirm plan change"
      confirmDisabled={unchanged}
      formId={formId}
      loading={mutation.isPending}
      footerStart={<LoggedAs />}
      onConfirm={() => undefined}
      onCancel={onClose}
    >
      <form id={formId} noValidate onSubmit={handleSubmit((v) => mutation.mutate(v))} className="flex flex-col gap-5">
        <fieldset className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <legend className="text-body font-medium text-text-primary">New plan</legend>
            <Controller
              control={control}
              name="interval"
              render={({ field }) => (
                <SegmentedControl
                  size="sm"
                  aria-label="Billing interval"
                  value={field.value}
                  onChange={field.onChange}
                  options={[
                    { value: 'month', label: 'Monthly' },
                    { value: 'year', label: 'Yearly' },
                  ]}
                />
              )}
            />
          </div>
          {plans.isPending ? (
            <div className="grid gap-3 sm:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-24 rounded-lg" />
              ))}
            </div>
          ) : plans.isError ? (
            <FormError error={plans.error} />
          ) : (
            <Controller
              control={control}
              name="plan_code"
              render={({ field }) => (
                <div role="radiogroup" aria-label="New plan" className="grid gap-3 sm:grid-cols-3">
                  {plans.data.map((p) => {
                    const price = planPrice(p, interval);
                    const isCurrent = p.code === tenant.plan_code;
                    return (
                      <RadioCard
                        key={p.code}
                        checked={field.value === p.code}
                        onSelect={() => field.onChange(p.code)}
                        title={p.name}
                        badge={
                          isCurrent && <span className="rounded-full bg-surface-subtle px-2 py-0.5 text-caption font-medium text-text-secondary">Current</span>
                        }
                      >
                        <span className="pl-7 text-heading text-text-primary">
                          {price === null ? '—' : money(price)}
                          {price !== null && <span className="text-caption font-normal text-text-muted"> / {interval === 'year' ? 'year' : 'month'}</span>}
                        </span>
                      </RadioCard>
                    );
                  })}
                </div>
              )}
            />
          )}
          {formState.errors.plan_code && <p className="text-caption text-danger">{formState.errors.plan_code.message}</p>}
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-body font-medium text-text-primary">Effective date</legend>
          <Controller
            control={control}
            name="effective"
            render={({ field }) => (
              <div role="radiogroup" aria-label="Effective date" className="grid gap-3 sm:grid-cols-2">
                <RadioCard
                  checked={field.value === 'now'}
                  onSelect={() => field.onChange('now' satisfies AdminPlanChangeEffective)}
                  title="Now"
                  hint="Switch today · no charge, the open invoice is voided"
                />
                <RadioCard
                  checked={field.value === 'next_renewal'}
                  onSelect={() => field.onChange('next_renewal' satisfies AdminPlanChangeEffective)}
                  title="At next renewal"
                  hint={renewal ? `${formatDate(renewal)} · no proration` : 'At the end of the current period'}
                />
              </div>
            )}
          />
        </fieldset>

        {planCode && !unchanged && (
          <div aria-live="polite" className="flex flex-col gap-2 rounded-lg bg-surface-subtle px-4 py-3.5">
            <p className="text-body font-semibold text-text-primary">Preview</p>
            {quote.isPending ? (
              <Skeleton className="h-4 w-2/3" />
            ) : quote.isError ? (
              <FormError error={quote.error} />
            ) : (
              <>
                <p className="flex justify-between gap-3 text-body text-text-secondary">
                  <span>
                    {quote.data.plan.name} · {intervalLabel(quote.data.interval).toLowerCase()}, from {formatDate(quote.data.effective_at)}
                  </span>
                  <span className="text-text-primary tabular-nums">{money(planPrice(quote.data.plan, quote.data.interval))}</span>
                </p>
                {effective === 'now' && (
                  <p className="text-caption text-text-muted">No invoice is issued for this change. Use it only after a manual payment or as goodwill.</p>
                )}
                {quote.data.warnings.length > 0 && (
                  <ul aria-label="Warnings" className="flex flex-col gap-1.5">
                    {quote.data.warnings.map((w) => (
                      <li key={w.key} className="flex items-start gap-2 text-caption text-warning">
                        <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                        {w.message}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}
        {unchanged && <p className="text-caption text-text-muted">The shop is already on this plan and interval.</p>}

        <Controller
          control={control}
          name="notify"
          render={({ field }) => (
            <div className="flex items-center gap-3">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-body font-medium text-text-primary">Notify merchant</span>
                <span className="text-caption text-text-muted">Email {tenant.owner?.name ?? 'the owner'} (owner) about the new plan</span>
              </div>
              <Toggle label="Notify merchant" checked={field.value} onChange={field.onChange} />
            </div>
          )}
        />
        <ReasonField error={formState.errors.reason?.message} {...register('reason')} />
        <FormError error={mutation.error} />
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Extend (P8-14)

const extendSchema = z.object({
  days: z.number({ error: 'Enter a number of days' }).int('Whole days only').min(1, 'At least 1 day').max(90, 'At most 90 days'),
  reason: reasonSchema,
});
type ExtendValues = z.infer<typeof extendSchema>;

export function extendLabel(tenant: Pick<AdminTenant, 'subscription_status'>): string {
  return tenant.subscription_status === 'trialing' ? 'Extend trial' : 'Extend period';
}

export function ExtendDialog({ tenant, onClose, onDone }: { tenant: AdminTenant; onClose: () => void; onDone: (s: Subscription) => void }) {
  const formId = useId();
  const status = tenant.subscription_status;
  const { register, handleSubmit, setValue, watch, formState } = useForm<ExtendValues>({
    resolver: zodResolver(extendSchema),
    defaultValues: { days: 14, reason: '' },
  });
  const days = Number(watch('days'));
  const mutation = useMutation({
    mutationFn: (v: ExtendValues) =>
      api.admin.tenants.extend(tenant.id, {
        days: v.days,
        reason: v.reason.trim(),
      }),
    onSuccess: onDone,
  });
  const what =
    status === 'trialing'
      ? `Moves the trial end (${formatDate(tenant.trial_ends_at)}) later.`
      : status === 'past_due'
      ? `Moves the grace period end${tenant.subscription?.grace_ends_at ? ` (${formatDate(tenant.subscription.grace_ends_at)})` : ''} later.`
      : `Moves the period end (${formatDate(tenant.current_period_end)}) later. No invoice is issued.`;
  return (
    <Dialog
      open
      title={`${extendLabel(tenant)} · ${tenant.name}`}
      description={what}
      size="md"
      confirmLabel={extendLabel(tenant)}
      formId={formId}
      loading={mutation.isPending}
      footerStart={<LoggedAs />}
      onConfirm={() => undefined}
      onCancel={onClose}
    >
      <form id={formId} noValidate onSubmit={handleSubmit((v) => mutation.mutate(v))} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <div role="group" aria-label="Quick choices" className="flex flex-wrap gap-2">
            {[7, 14, 30].map((d) => (
              <Chip key={d} check={false} selected={days === d} onClick={() => setValue('days', d, { shouldValidate: true })} className="px-3 py-1.5">
                {d} days
              </Chip>
            ))}
          </div>
          <Input
            label="Days"
            type="number"
            inputMode="numeric"
            min={1}
            max={90}
            hint="1–90 days"
            error={formState.errors.days?.message}
            {...register('days', { valueAsNumber: true })}
          />
        </div>
        <ReasonField error={formState.errors.reason?.message} {...register('reason')} />
        <FormError error={mutation.error} />
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Suspend (45:8866, P8-12)

export const suspensionReasons: {
  code: SuspensionReasonCode;
  label: string;
  hint: string;
}[] = [
  {
    code: 'unpaid',
    label: 'Unpaid',
    hint: 'Subscription unpaid past the grace period',
  },
  {
    code: 'fraud',
    label: 'Fraud reports',
    hint: 'Chargebacks or buyer complaints',
  },
  {
    code: 'terms_violation',
    label: 'Terms violation',
    hint: 'Prohibited products or content',
  },
  {
    code: 'merchant_request',
    label: 'Merchant request',
    hint: 'Owner asked to pause the shop',
  },
  { code: 'other', label: 'Other', hint: 'Explain in the reason' },
];

export function SuspendDialog({ tenant, onClose, onDone }: { tenant: AdminTenant; onClose: () => void; onDone: (t: AdminTenant) => void }) {
  const formId = useId();
  const schema = z.object({
    reason_code: z.enum(['unpaid', 'fraud', 'terms_violation', 'merchant_request', 'other'], { error: 'Choose a reason' }),
    notify: z.boolean(),
    reason: reasonSchema,
    confirm: z.string().refine((v) => v.trim() === tenant.name.trim(), 'Type the shop name exactly to confirm'),
  });
  type Values = z.infer<typeof schema>;
  const { control, register, handleSubmit, watch, formState } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      reason_code: undefined,
      notify: true,
      reason: '',
      confirm: '',
    },
  });
  const matches = watch('confirm').trim() === tenant.name.trim();
  const mutation = useMutation({
    mutationFn: (v: Values) =>
      api.admin.tenants.suspend(tenant.id, {
        reason_code: v.reason_code,
        reason: v.reason.trim(),
        notify: v.notify,
      }),
    onSuccess: onDone,
  });

  return (
    <Dialog
      open
      title={`Suspend ${tenant.name}?`}
      description="The shop goes offline right away. You can reactivate it any time from this page."
      icon={<AlertTriangle />}
      size="lg"
      tone="danger"
      confirmLabel="Suspend merchant"
      formId={formId}
      loading={mutation.isPending}
      footerStart={<LoggedAs />}
      onConfirm={() => undefined}
      onCancel={onClose}
    >
      <form id={formId} noValidate onSubmit={handleSubmit((v) => mutation.mutate(v))} className="flex flex-col gap-5">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-body font-medium text-text-primary">Reason</legend>
          <Controller
            control={control}
            name="reason_code"
            render={({ field }) => (
              <div role="radiogroup" aria-label="Suspension reason" className="grid gap-3 sm:grid-cols-2">
                {suspensionReasons.map((r) => (
                  <RadioCard
                    key={r.code}
                    tone="danger"
                    checked={field.value === r.code}
                    onSelect={() => field.onChange(r.code)}
                    title={r.label}
                    hint={r.hint}
                  />
                ))}
              </div>
            )}
          />
          {formState.errors.reason_code && <p className="text-caption text-danger">{formState.errors.reason_code.message}</p>}
        </fieldset>

        <div className="flex flex-col gap-3 rounded-lg bg-surface-subtle px-4 py-3.5">
          <p className="text-body font-semibold text-text-primary">What happens</p>
          <Happens icon={<Store />} title="Storefront shows “temporarily unavailable”" hint={`${tenant.store?.primary_host ?? 'The storefront'} and every connected domain`} />
          <Happens icon={<LayoutDashboard />} title="Merchant dashboard is locked" hint="Staff see “Your shop is suspended”; no new orders can be placed" />
          <Happens icon={<CreditCard />} title="Payments already in flight still settle" hint="Billing keeps running; custom domains keep their status" />
        </div>

        <Controller
          control={control}
          name="notify"
          render={({ field }) => (
            <div className="flex flex-col gap-2">
              <span className="text-body font-medium text-text-primary">Notify merchant</span>
              <Checkbox label={`Email ${tenant.owner?.email ?? 'the owner'}`} checked={field.value} onChange={(e) => field.onChange(e.target.checked)} />
            </div>
          )}
        />
        <ReasonField error={formState.errors.reason?.message} {...register('reason')} />
        <Input
          label={`Type ${tenant.name} to confirm`}
          autoComplete="off"
          spellCheck={false}
          error={formState.errors.confirm?.message}
          hint={matches ? 'Name matches. This action is logged with your name and reason.' : undefined}
          trailing={matches ? <Check aria-hidden className="size-5 text-success" /> : undefined}
          {...register('confirm')}
        />
        <FormError error={mutation.error} />
      </form>
    </Dialog>
  );
}

function Happens({ icon, title, hint }: { icon: ReactNode; title: string; hint: string }) {
  return (
    <div className="flex gap-3">
      <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-card text-danger [&_svg]:size-4">
        {icon}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-body font-medium text-text-primary">{title}</span>
        <span className="text-caption text-text-muted">{hint}</span>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- Reactivate (composed from 45:8866)

export function ReactivateDialog({ tenant, onClose, onDone }: { tenant: AdminTenant; onClose: () => void; onDone: (t: AdminTenant) => void }) {
  const formId = useId();
  const schema = z.object({ notify: z.boolean(), reason: reasonSchema });
  type Values = z.infer<typeof schema>;
  const { control, register, handleSubmit, formState } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { notify: true, reason: '' },
  });
  const mutation = useMutation({
    mutationFn: (v: Values) =>
      api.admin.tenants.reactivate(tenant.id, {
        reason: v.reason.trim(),
        notify: v.notify,
      }),
    onSuccess: onDone,
  });
  const back =
    tenant.suspension?.store_status_before === 'draft'
      ? 'The store returns to draft (Coming soon page).'
      : 'The storefront and dashboard come back online right away.';
  return (
    <Dialog
      open
      title={`Reactivate ${tenant.name}?`}
      description={back}
      size="md"
      confirmLabel="Reactivate merchant"
      formId={formId}
      loading={mutation.isPending}
      footerStart={<LoggedAs />}
      onConfirm={() => undefined}
      onCancel={onClose}
    >
      <form id={formId} noValidate onSubmit={handleSubmit((v) => mutation.mutate(v))} className="flex flex-col gap-4">
        <Controller
          control={control}
          name="notify"
          render={({ field }) => (
            <Checkbox label={`Email ${tenant.owner?.email ?? 'the owner'}`} checked={field.value} onChange={(e) => field.onChange(e.target.checked)} />
          )}
        />
        <ReasonField error={formState.errors.reason?.message} {...register('reason')} />
        <FormError error={mutation.error} />
      </form>
    </Dialog>
  );
}
