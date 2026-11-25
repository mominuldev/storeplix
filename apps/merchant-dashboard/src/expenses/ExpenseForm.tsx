import { zodResolver } from '@hookform/resolvers/zod';
import { isApiError } from '@storeplix/api-client';
import {
  EXPENSE_CATEGORIES,
  EXPENSE_COURIER_HINT,
  EXPENSE_MIN_DATE,
  EXPENSE_NOTE_MAX,
  EXPENSE_RECEIPT_MAX_BYTES,
  PAID_FROM_LABELS,
  PAID_FROM_OPTIONS,
  type Expense,
  type ExpenseReceiptMime,
  type MediaStatus,
} from '@storeplix/types';
import { Button, Dialog, FileDrop, Input, MoneyInput, Select, Toggle } from '@storeplix/ui';
import { FileText, Paperclip, X } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm, useWatch, type FieldPath } from 'react-hook-form';
import { useStoreScope } from '../catalog/scope';
import { useReadOnly } from '../impersonation/hooks';
import { api } from '../lib/api';
import { toast } from '../online-store/components/Toast';
import { backdateHint, categoryLabel, emptyValues, expenseSchema, noteOf, prepareReceipt, valuesOf, type ExpenseValues } from './expenses';
import { useExpenseMutations } from './queries';

// Card "Add expense" 144:42394 (Amount 144:42398, Category + Paid from 144:42404, Date, Note, Receipt drop 144:42429,
// Repeat 144:42436 + toggle 144:42440, Save 144:42442). Edit mode is composed (§10.1): title "Edit expense", same
// fields, "Delete" (ghost, danger, with confirm) and "Cancel".

const ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';

interface ReceiptState {
  id: string;
  name: string;
  mime: ExpenseReceiptMime;
  status: MediaStatus;
}

export function ExpenseForm({ editing, today, onDone, id }: { editing: Expense | null; today: string; onDone: () => void; id?: string }) {
  const scope = useStoreScope();
  const readOnly = useReadOnly();
  const { create, update, remove } = useExpenseMutations();
  const initialReceipt: ReceiptState | null = editing?.receipt ? { id: editing.receipt.id, name: 'Receipt attached', mime: editing.receipt.mime, status: editing.receipt.status } : null;
  const [receipt, setReceipt] = useState<ReceiptState | null>(initialReceipt);
  const [upload, setUpload] = useState<{ progress: number } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const {
    register,
    control,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<ExpenseValues>({ resolver: zodResolver(expenseSchema(today)), defaultValues: editing ? valuesOf(editing) : emptyValues(today) });
  const category = useWatch({ control, name: 'category' });
  const spentOn = useWatch({ control, name: 'spent_on' });
  const hint = backdateHint(spentOn, today);
  const saving = create.isPending || update.isPending;

  const pick = async (files: File[]) => {
    const original = files[0];
    if (!original || !scope.storeId) return;
    setUploadError(null);
    const file = await prepareReceipt(original);
    if (file.size > EXPENSE_RECEIPT_MAX_BYTES) return setUploadError('The file may not be larger than 5 MB.');
    setUpload({ progress: 0 });
    try {
      const r = await api.expenses.uploadReceipt(scope.storeId, { file, filename: file.name }, { onProgress: (p) => setUpload({ progress: p }) });
      setReceipt({ id: r.id, name: original.name, mime: r.mime, status: r.status });
    } catch (e) {
      setUploadError(isApiError(e) ? (e.fieldError('file') ?? e.message) : 'Upload failed. Check your connection.');
    } finally {
      setUpload(null);
    }
  };

  const onSubmit = handleSubmit(async (v) => {
    setFormError(null);
    const base = { amount: v.amount!, category: v.category, paid_from: v.paid_from, spent_on: v.spent_on, note: noteOf(v.note), repeat_monthly: v.repeat_monthly };
    try {
      if (editing) {
        const receiptChanged = (receipt?.id ?? null) !== (editing.receipt?.id ?? null);
        await update.mutateAsync({ id: editing.id, input: { ...base, ...(receiptChanged ? { receipt_id: receipt?.id ?? null } : {}) } });
        toast('Expense updated.');
      } else {
        await create.mutateAsync({ ...base, ...(receipt ? { receipt_id: receipt.id } : {}) });
        toast('Expense saved.');
        reset(emptyValues(today));
        setReceipt(null);
      }
      onDone();
    } catch (e) {
      if (isApiError(e) && e.isValidation && e.fieldErrors) {
        let mapped = false;
        for (const [field, messages] of Object.entries(e.fieldErrors)) {
          if (field === 'receipt_id') {
            setUploadError(messages[0] ?? 'Upload the receipt again.');
            mapped = true;
          } else if (['amount', 'category', 'paid_from', 'spent_on', 'note', 'repeat_monthly'].includes(field)) {
            setError(field as FieldPath<ExpenseValues>, { message: messages[0] });
            mapped = true;
          }
        }
        if (mapped) return;
      }
      setFormError(isApiError(e) ? e.message : 'We couldn’t save this expense. Try again.');
    }
  });

  const doDelete = async () => {
    if (!editing) return;
    try {
      await remove.mutateAsync(editing.id);
      setConfirmDelete(false);
      toast('Expense deleted.');
      onDone();
    } catch (e) {
      setConfirmDelete(false);
      setFormError(isApiError(e) ? e.message : 'We couldn’t delete this expense. Try again.');
    }
  };

  return (
    <section id={id} aria-label={editing ? 'Edit expense' : 'Add expense'} className="flex flex-col gap-3.5 rounded-card border border-border-default bg-surface-card p-4 shadow-elevation-1 sm:p-6">
      <h2 className="text-body-lg font-medium text-text-primary">{editing ? 'Edit expense' : 'Add expense'}</h2>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3.5">
        <Controller
          control={control}
          name="amount"
          render={({ field }) => <MoneyInput label="Amount" placeholder="0" value={field.value} onChange={field.onChange} onBlur={field.onBlur} error={errors.amount?.message} />}
        />
        <div className="grid grid-cols-2 gap-2.5">
          <Select label="Category" error={errors.category?.message} {...register('category')}>
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {categoryLabel(c)}
              </option>
            ))}
          </Select>
          <Select label="Paid from" error={errors.paid_from?.message} {...register('paid_from')}>
            {PAID_FROM_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {PAID_FROM_LABELS[p]}
              </option>
            ))}
          </Select>
        </div>
        {category === 'courier' && <p className="-mt-1.5 text-caption text-text-muted">{EXPENSE_COURIER_HINT}</p>}
        <Input label="Date" type="date" min={EXPENSE_MIN_DATE} max={today} error={errors.spent_on?.message} hint={hint ?? undefined} {...register('spent_on')} />
        <Input label="Note" placeholder="What was it for?" maxLength={EXPENSE_NOTE_MAX} error={errors.note?.message} {...register('note')} />

        {receipt ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2.5 rounded-lg border border-border-default px-3 py-2.5">
              {receipt.mime === 'application/pdf' ? <FileText aria-hidden className="size-4 shrink-0 text-text-secondary" /> : <Paperclip aria-hidden className="size-4 shrink-0 text-text-secondary" />}
              <span className="min-w-0 flex-1 truncate text-body text-text-primary">{receipt.name}</span>
              {receipt.status === 'processing' && <span className="text-caption text-text-muted">Processing…</span>}
              <button
                type="button"
                aria-label="Remove receipt"
                onClick={() => {
                  setReceipt(null);
                  setUploadError(null);
                }}
                className="rounded-md p-1 text-text-secondary outline-none hover:bg-surface-subtle focus-visible:shadow-focus"
              >
                <X aria-hidden className="size-4" />
              </button>
            </div>
            {uploadError && (
              <p role="alert" className="text-caption text-danger">
                {uploadError}
              </p>
            )}
          </div>
        ) : (
          <FileDrop
            label={upload ? `Uploading… ${Math.round(upload.progress * 100)}%` : 'Add receipt photo'}
            hint="JPG, PNG, WebP or PDF · up to 5 MB"
            accept={ACCEPT}
            disabled={!!upload || readOnly}
            error={uploadError}
            onFiles={(f) => void pick(f)}
            className="[&>label]:border-border-default [&>label]:bg-surface-card [&>label]:py-4"
          />
        )}

        <div className="flex items-center gap-2.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-body font-medium text-text-primary">
              Repeat every month
            </span>
            <span className="text-caption text-text-secondary">For rent, salaries and subscriptions</span>
          </div>
          <Controller control={control} name="repeat_monthly" render={({ field }) => <Toggle label="Repeat every month" checked={field.value} onChange={field.onChange} />} />
        </div>

        {formError && (
          <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-body text-danger">
            {formError}
          </p>
        )}
        <Button type="submit" fullWidth loading={saving} disabled={readOnly || !!upload}>
          Save expense
        </Button>
        {editing && (
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" className="text-danger hover:bg-danger-bg" disabled={readOnly} onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
            <span className="flex-1" />
            <Button type="button" variant="secondary" onClick={onDone}>
              Cancel
            </Button>
          </div>
        )}
      </form>
      <Dialog
        open={confirmDelete}
        tone="danger"
        title="Delete this expense?"
        description="It is removed from Expenses and Profit & loss, and its receipt is deleted. This can’t be undone."
        confirmLabel="Delete expense"
        loading={remove.isPending}
        onConfirm={() => void doDelete()}
        onCancel={() => setConfirmDelete(false)}
      />
    </section>
  );
}
