import { zodResolver } from '@hookform/resolvers/zod';
import { isApiError } from '@storeplix/api-client';
import type { SmsSenderIdRequest, SmsSenderIdUse } from '@storeplix/types';
import { SMS_SENDER_ID_NOTE_MAX, SMS_SENDER_ID_PATTERN, SMS_SENDER_ID_USE_LABELS, SMS_SENDER_ID_USES } from '@storeplix/types';
import { Badge, Button, Checkbox, Chip, cn, Dialog, FileDrop, Input, Skeleton } from '@storeplix/ui';
import { Check, ChevronDown, FileText, Info } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { useStoreScope } from '../catalog/scope';
import { ErrorBlock } from '../catalog/states';
import { toast } from '../online-store/components/Toast';
import { formatDate } from '../plan/billing';
import { Panel } from './components';
import { smsErrorText } from './errors';
import { useCancelSenderId, useRequestSenderId, useSenderIds } from './queries';
import { documentProblem, fileSize, SENDER_STATUS_META, usesLabel } from './sms';

// Figma Sender ID 2075:50625 (§12.3): current sender, pending request + timeline + cancel, request form (multipart with
// the trade licence, upload progress), "When the review is done" (last decision), "Good to know", composed history.

export const senderIdSchema = z.object({
  sender_id: z.string().trim().regex(SMS_SENDER_ID_PATTERN, 'Use 3–11 letters or numbers, with at least one letter. No spaces or symbols.'),
  business_name: z.string().trim().min(2, 'Enter the business name on the trade licence.').max(120, 'Keep it under 120 characters.'),
  uses: z.array(z.enum(SMS_SENDER_ID_USES as unknown as [SmsSenderIdUse, ...SmsSenderIdUse[]])).min(1, 'Pick at least one.'),
  note: z.string().max(SMS_SENDER_ID_NOTE_MAX, `Keep the note under ${SMS_SENDER_ID_NOTE_MAX} characters.`),
  rights_confirmed: z.boolean().refine((v) => v, 'Tick to confirm the name belongs to your business.'),
  document: z.custom<File | null>().superRefine((f, ctx) => {
    if (!(f instanceof File)) ctx.addIssue({ code: 'custom', message: 'Upload your trade licence.' });
    else {
      const p = documentProblem(f);
      if (p) ctx.addIssue({ code: 'custom', message: p });
    }
  }),
});
export type SenderIdValues = z.input<typeof senderIdSchema>;

const emptyValues = (from?: SmsSenderIdRequest | null): SenderIdValues => ({
  sender_id: from?.sender_id ?? '',
  business_name: from?.business_name ?? '',
  uses: from?.uses ?? ['order_updates'],
  note: '',
  rights_confirmed: false,
  document: null,
});

export function SenderIdTab({ canRequest, readOnly }: { canRequest: boolean; readOnly: boolean }) {
  const list = useSenderIds();
  const [prefill, setPrefill] = useState<SmsSenderIdRequest | null>(null);
  const [formKey, setFormKey] = useState(0);

  if (list.isPending) {
    return (
      <div className="flex flex-col gap-5">
        <Skeleton className="h-44 rounded-card" />
        <Skeleton className="h-64 rounded-card" />
      </div>
    );
  }
  if (list.isError) return <ErrorBlock title="We couldn’t load your sender ID" error={list.error} onRetry={() => void list.refetch()} />;
  const { active, pending, history } = list.data;
  const lastDecision = history.find((h) => h.status === 'approved' || h.status === 'rejected' || h.status === 'revoked') ?? null;
  const older = history.filter((h) => h.id !== pending?.id && h.id !== active?.id);

  return (
    <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-5">
        <CurrentSender active={active} />
        {pending && <PendingRequest request={pending} canCancel={canRequest && !readOnly} />}
        {!pending && canRequest && (
          <RequestForm
            key={formKey}
            prefill={prefill}
            readOnly={readOnly}
            onDone={() => {
              setPrefill(null);
              setFormKey((k) => k + 1);
            }}
          />
        )}
        {older.length > 0 && <History items={older} />}
      </div>
      <div className="flex flex-col gap-5 lg:w-[280px] lg:shrink-0">
        <Panel title="When the review is done">
          {lastDecision ? (
            <Decision
              request={lastDecision}
              onAgain={
                lastDecision.status !== 'approved' && canRequest && !pending
                  ? () => {
                      setPrefill(lastDecision);
                      setFormKey((k) => k + 1);
                    }
                  : undefined
              }
            />
          ) : (
            <p className="text-caption text-text-secondary">Approved: your messages switch to the new name automatically. Rejected: you’ll see the reason here and can request again.</p>
          )}
        </Panel>
        <Panel title="Good to know">
          <ul className="flex flex-col gap-2 text-caption text-text-secondary">
            {['One sender ID per shop. Requesting a new one replaces the old one when it is approved.', 'Checkout OTP and order updates use the same sender.', 'Sending keeps working during review — from Storeplix.'].map((t) => (
              <li key={t} className="flex gap-2">
                <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-text-muted" />
                {t}
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}

function CurrentSender({ active }: { active: SmsSenderIdRequest | null }) {
  const { store } = useStoreScope();
  const shop = store?.name ?? 'Your shop';
  return (
    <Panel title="Current sender" description="The name customers see as the sender of every SMS from your shop.">
      <div className="flex flex-col gap-4 sm:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-heading font-semibold text-text-primary">{active ? active.sender_id : 'Storeplix'}</span>
            {active ? (
              <Badge tone="success" dot size="sm">
                Approved
              </Badge>
            ) : (
              <Badge size="sm">Platform default</Badge>
            )}
          </div>
          <p className="text-body text-text-secondary">
            {active
              ? `Live since ${formatDate(active.reviewed_at ?? active.requested_at)}. All SMS now come from ${active.sender_id} and the shop-name prefix is removed.`
              : `You don’t have your own sender ID yet, so messages come from Storeplix. We add your shop name in front — “${shop}: …” — so customers know who it is. Once a masked sender ID is approved the prefix is dropped.`}
          </p>
        </div>
        <div className="flex flex-col gap-2 rounded-card bg-surface-subtle p-3 sm:w-[240px] sm:shrink-0">
          <p className="text-center text-caption text-text-secondary">
            <span className="block font-medium text-text-primary">{active ? active.sender_id : 'Storeplix'}</span>
            Text message · now
          </p>
          <p className="rounded-card bg-surface-card px-3 py-2 text-caption text-text-primary">
            {!active && <span className="text-brand-600">{shop}: </span>}Order #1042 is confirmed.
          </p>
          {!active && <p className="text-center text-caption text-text-muted">Prefix “{shop}: ” added automatically</p>}
        </div>
      </div>
    </Panel>
  );
}

function PendingRequest({ request, canCancel }: { request: SmsSenderIdRequest; canCancel: boolean }) {
  const cancel = useCancelSenderId();
  const [confirm, setConfirm] = useState(false);
  const steps = [
    { title: 'Submitted', body: `${formatDate(request.requested_at)} · trade licence uploaded`, state: 'done' as const },
    { title: 'Pending review', body: `Storeplix checks your licence, then registers ${request.sender_id} with BTRC through REVE SMS. This usually takes 7–10 working days.`, state: 'current' as const },
    { title: 'Approved or rejected', body: `Approved: your messages switch to ${request.sender_id} automatically. Rejected: you’ll see the reason here and can request again.`, state: 'todo' as const },
  ];
  return (
    <Panel
      label="Pending request"
      title={
        <span className="flex flex-wrap items-center gap-2">
          {request.sender_id}
          <Badge tone="warning" dot size="sm">
            Pending review
          </Badge>
        </span>
      }
      description={`Requested ${formatDate(request.requested_at)}${request.requested_by ? ` by ${request.requested_by.name}` : ''} · for ${usesLabel(request.uses)}`}
      actions={
        canCancel && (
          <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
            Cancel request
          </Button>
        )
      }
    >
      <ol aria-label="Request progress" className="flex flex-col">
        {steps.map((s, i) => (
          <li key={s.title} className="relative flex gap-3 pb-4 last:pb-0">
            {i < steps.length - 1 && <span aria-hidden className="absolute top-6 bottom-0 left-[9px] w-px bg-border-default" />}
            <span
              aria-hidden
              className={cn(
                'relative flex size-5 shrink-0 items-center justify-center rounded-full',
                s.state === 'done' ? 'bg-success text-text-inverse' : s.state === 'current' ? 'border-2 border-brand-600 bg-surface-card' : 'border border-border-strong bg-surface-card',
              )}
            >
              {s.state === 'done' ? <Check className="size-3" /> : s.state === 'current' ? <span className="size-2 rounded-full bg-brand-600" /> : null}
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className={cn('text-body font-medium', s.state === 'todo' ? 'text-text-secondary' : 'text-text-primary')}>{s.title}</span>
              <span className="text-caption text-text-secondary">{s.body}</span>
            </div>
          </li>
        ))}
      </ol>
      <p className="flex items-start gap-2 rounded-lg bg-info-bg px-3 py-2.5 text-caption text-info">
        <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        Until then your SMS keep going out from Storeplix with your shop-name prefix — nothing stops.
      </p>
      <Dialog
        open={confirm}
        tone="danger"
        title={`Cancel the request for ${request.sender_id}?`}
        description="Storeplix stops reviewing it. You can send a new request any time."
        confirmLabel="Cancel request"
        cancelLabel="Keep it"
        loading={cancel.isPending}
        onCancel={() => setConfirm(false)}
        onConfirm={() =>
          cancel.mutate(request.id, {
            onSuccess: () => {
              setConfirm(false);
              toast('Request cancelled.');
            },
            onError: (e) => {
              setConfirm(false);
              toast(smsErrorText(e), 'error');
            },
          })
        }
      />
    </Panel>
  );
}

function RequestForm({ prefill, readOnly, onDone }: { prefill: SmsSenderIdRequest | null; readOnly: boolean; onDone: () => void }) {
  const request = useRequestSenderId();
  const [progress, setProgress] = useState<number | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<SenderIdValues>({ resolver: zodResolver(senderIdSchema), defaultValues: emptyValues(prefill) });
  const senderId = useWatch({ control, name: 'sender_id' }) ?? '';

  const submit = handleSubmit((v) => {
    setFormError(null);
    const file = v.document as File;
    request.mutate(
      {
        input: { sender_id: v.sender_id.trim(), business_name: v.business_name.trim(), uses: v.uses, note: v.note.trim() || null, rights_confirmed: true, document: file, filename: file.name },
        opts: { onProgress: (f) => setProgress(f) },
      },
      {
        onSuccess: () => {
          setProgress(null);
          toast('Request sent. Review takes about 7–10 working days.');
          onDone();
        },
        onError: (e) => {
          setProgress(null);
          const msg = smsErrorText(e);
          if (isApiError(e) && ['sender_id_taken', 'sender_id_reserved', 'sender_id_unchanged'].includes(e.code)) setError('sender_id', { message: msg });
          else if (isApiError(e) && e.fieldError('document')) setError('document', { message: e.fieldError('document') });
          else if (isApiError(e) && e.fieldError('sender_id')) setError('sender_id', { message: e.fieldError('sender_id') });
          else setFormError(msg);
        },
      },
    );
  });

  return (
    <Panel title="Request a masked sender ID" description="Show your own name instead of “Storeplix” on customers’ phones.">
      <form noValidate onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" aria-label="Request a masked sender ID">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Input
              label="Sender ID"
              maxLength={11}
              autoCapitalize="characters"
              className="uppercase"
              error={errors.sender_id?.message}
              {...register('sender_id', { setValueAs: (v: string) => v.toUpperCase() })}
            />
            <p className="flex justify-between gap-2 text-caption text-text-muted">
              <span>3–11 letters or numbers, no spaces or symbols.</span>
              <span>{senderId.trim().length} / 11</span>
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <Input label="Business name on the trade licence" error={errors.business_name?.message} {...register('business_name')} />
            <p className="text-caption text-text-muted">Must match the licence you upload.</p>
          </div>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-body font-medium text-text-primary">What will you send with it?</legend>
          <Controller
            control={control}
            name="uses"
            render={({ field }) => (
              <div className="flex flex-wrap gap-2">
                {SMS_SENDER_ID_USES.map((u) => {
                  const on = field.value.includes(u);
                  return (
                    <Chip key={u} selected={on} check={false} onClick={() => field.onChange(on ? field.value.filter((x) => x !== u) : [...field.value, u])}>
                      {SMS_SENDER_ID_USE_LABELS[u]}
                    </Chip>
                  );
                })}
                <Chip disabled check={false} title="Needs a separate approval later" className="cursor-not-allowed opacity-60">
                  Promotions
                </Chip>
              </div>
            )}
          />
          <p className={cn('text-caption', errors.uses ? 'text-danger' : 'text-text-muted')}>{errors.uses?.message ?? 'BTRC asks what the sender ID is used for. Promotions need a separate approval later.'}</p>
        </fieldset>
        <Controller
          control={control}
          name="document"
          render={({ field }) => (
            <div className="flex flex-col gap-2">
              <span className="text-body font-medium text-text-primary">Trade licence</span>
              {field.value instanceof File ? (
                <div className="flex items-center gap-3 rounded-card border border-border-default px-4 py-3">
                  <FileText aria-hidden className="size-4 shrink-0 text-brand-600" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-body font-medium text-text-primary">{field.value.name}</span>
                    <span className="text-caption text-text-muted">
                      {fileSize(field.value.size)}
                      {progress !== null ? ` · uploading ${Math.round(progress * 100)}%` : ''}
                    </span>
                  </span>
                  <Button size="sm" variant="ghost" className="text-danger" disabled={request.isPending} onClick={() => field.onChange(null)}>
                    Remove
                  </Button>
                </div>
              ) : (
                <FileDrop
                  label="Drop a file here or browse"
                  hint="PDF, JPG, PNG or WebP · up to 5 MB"
                  accept="application/pdf,image/jpeg,image/png,image/webp"
                  error={errors.document?.message ?? null}
                  onFiles={(files) => field.onChange(files[0] ?? null)}
                />
              )}
              {field.value instanceof File && errors.document?.message && <p className="text-caption text-danger">{errors.document.message}</p>}
            </div>
          )}
        />
        <div className="flex flex-col gap-1">
          <label htmlFor="sender-note" className="text-body font-medium text-text-primary">
            Note for the reviewer <span className="font-normal text-text-muted">(optional)</span>
          </label>
          <textarea
            id="sender-note"
            rows={2}
            maxLength={SMS_SENDER_ID_NOTE_MAX}
            className="w-full rounded-control border border-border-default bg-surface-card px-3 py-2 text-body text-text-primary outline-none focus:border-brand-600 focus:shadow-focus"
            {...register('note')}
          />
          {errors.note && <p className="text-caption text-danger">{errors.note.message}</p>}
        </div>
        <div className="flex flex-col gap-1">
          <Controller
            control={control}
            name="rights_confirmed"
            render={({ field }) => <Checkbox label="This name belongs to my business and I have the right to use it." checked={field.value} onChange={(e) => field.onChange(e.target.checked)} />}
          />
          {errors.rights_confirmed && <p className="text-caption text-danger">{errors.rights_confirmed.message}</p>}
        </div>
        {formError && (
          <p role="alert" className="rounded-lg bg-danger-bg px-3 py-2.5 text-caption font-medium text-danger">
            {formError}
          </p>
        )}
        <div className="flex flex-col gap-3 border-t border-border-default pt-4 sm:flex-row sm:items-center">
          <p className="flex-1 text-caption text-text-secondary">Review takes about 7–10 working days after you submit.</p>
          <Button type="submit" loading={request.isPending} disabled={readOnly || request.isPending}>
            Submit request
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function Decision({ request, onAgain }: { request: SmsSenderIdRequest; onAgain?: () => void }) {
  const meta = SENDER_STATUS_META[request.status];
  return (
    <div className="flex flex-col gap-2 rounded-card border border-border-default p-3">
      <div className="flex items-center gap-2">
        <span className="text-body font-semibold text-text-primary">{request.sender_id}</span>
        <Badge tone={meta.tone} dot size="sm">
          {meta.label}
        </Badge>
      </div>
      {request.status === 'approved' ? (
        <p className="text-caption text-text-secondary">Live since {formatDate(request.reviewed_at)}. All SMS now come from {request.sender_id} and the shop-name prefix is removed.</p>
      ) : (
        request.decision_reason && (
          <div className="rounded-lg bg-danger-bg px-3 py-2 text-caption text-text-primary">
            <span className="block font-medium text-danger">Reason</span>
            {request.decision_reason}
          </div>
        )
      )}
      {onAgain && (
        <Button size="sm" variant="secondary" className="self-start" onClick={onAgain}>
          Request again
        </Button>
      )}
    </div>
  );
}

function History({ items }: { items: SmsSenderIdRequest[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Panel
      title="Earlier requests"
      actions={
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)} leftIcon={<ChevronDown aria-hidden className={cn('size-4 transition-transform', open && 'rotate-180')} />}>
          {open ? 'Hide' : `Show ${items.length}`}
        </Button>
      }
    >
      {open && (
        <ul aria-label="Earlier requests" className="flex flex-col">
          {items.map((r) => {
            const meta = SENDER_STATUS_META[r.status];
            return (
              <li key={r.id} className="flex flex-wrap items-center gap-2 border-t border-border-default py-2.5 first:border-t-0">
                <span className="text-body font-medium text-text-primary">{r.sender_id}</span>
                <Badge tone={meta.tone} size="sm">
                  {meta.label}
                </Badge>
                <span className="flex-1 text-caption text-text-muted">{formatDate(r.requested_at)}</span>
                {r.decision_reason && <span className="w-full text-caption text-text-secondary">{r.decision_reason}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
