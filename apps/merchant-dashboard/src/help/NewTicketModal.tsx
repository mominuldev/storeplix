import { zodResolver } from '@hookform/resolvers/zod';
import type { OrderSummary, SupportAttachment, SupportTicket, SupportTicketCategory } from '@storeplix/types';
import { SUPPORT_LIMITS, SUPPORT_MERCHANT_PRIORITIES, SUPPORT_TICKET_CATEGORIES, SUPPORT_TICKET_CATEGORY_LABELS } from '@storeplix/types';
import { Button, Chip, cn, formatBdt, Input, Modal, OrderStatusBadge, Select } from '@storeplix/ui';
import { useQuery } from '@tanstack/react-query';
import { FileText, Plus, Search, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useNavigate } from 'react-router';
import { z } from 'zod';
import { useAuth } from '../auth/AuthProvider';
import { useStoreScope } from '../catalog/scope';
import { useReadOnly } from '../impersonation/hooks';
import { api } from '../lib/api';
import { BannerButton, HelpBanner } from './components';
import { helpErrorText } from './errors';
import { ATTACHMENT_ACCEPT, attachmentProblem, canLinkOrders, formatBytes, newClientId, PRIORITY_LABELS } from './help';
import { useCreateTicket, useUploadSupportAttachment } from './queries';

// PHASE-8-9C §13 New ticket modal 75:23121 / 75:22948: Category + Subject, Related order picker (only with
// `orders.view`; searches the orders list), "What happened?", Attachments (PNG/JPG/PDF ≤ 10 MB, max 5, progress),
// Priority chips Normal / High / Urgent (no "reply within 30 minutes" promise), Cancel / Submit ticket. A failed send
// keeps text and files and retries with the same `client_id`; success shows "Ticket T-n sent" with View ticket.

const merchantPriorities = SUPPORT_MERCHANT_PRIORITIES as readonly ('normal' | 'high' | 'urgent')[];

export const newTicketSchema = z.object({
  category: z.enum(SUPPORT_TICKET_CATEGORIES as unknown as [SupportTicketCategory, ...SupportTicketCategory[]], { message: 'Pick a category.' }),
  subject: z
    .string()
    .trim()
    .min(SUPPORT_LIMITS.subjectMin, `Use at least ${SUPPORT_LIMITS.subjectMin} characters.`)
    .max(SUPPORT_LIMITS.subject, `Keep it under ${SUPPORT_LIMITS.subject} characters.`),
  description: z
    .string()
    .trim()
    .min(SUPPORT_LIMITS.descriptionMin, `Tell us a bit more (at least ${SUPPORT_LIMITS.descriptionMin} characters).`)
    .max(SUPPORT_LIMITS.body, `Keep it under ${SUPPORT_LIMITS.body} characters.`),
  priority: z.enum(['normal', 'high', 'urgent']),
});
export type NewTicketValues = z.infer<typeof newTicketSchema>;

interface Upload {
  key: string;
  name: string;
  size: number;
  progress: number;
  attachment: SupportAttachment | null;
}
let uploadSeq = 0;

export interface NewTicketDefaults {
  category?: SupportTicketCategory;
  subject?: string;
}

interface NewTicketModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (t: SupportTicket) => void;
  defaults?: NewTicketDefaults;
}

/** Mounted only while open: every open starts a fresh form and a fresh idempotency key. */
export function NewTicketModal(props: NewTicketModalProps) {
  return props.open ? <NewTicketForm {...props} /> : null;
}

function NewTicketForm({ open, onClose, onCreated, defaults }: NewTicketModalProps) {
  const { activeTenant } = useAuth();
  const readOnly = useReadOnly();
  const showOrders = canLinkOrders(activeTenant);
  const create = useCreateTicket();
  const upload = useUploadSupportAttachment();
  const [clientId] = useState(newClientId);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [order, setOrder] = useState<OrderSummary | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const descId = useId();

  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<NewTicketValues>({
    resolver: zodResolver(newTicketSchema),
    defaultValues: { category: defaults?.category, subject: defaults?.subject ?? '', description: '', priority: 'normal' },
  });

  const uploading = uploads.some((u) => !u.attachment);

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    let count = uploads.length;
    const problems: string[] = [];
    for (const file of Array.from(files)) {
      const problem = attachmentProblem(file, count);
      if (problem) {
        problems.push(`${file.name}: ${problem}`);
        continue;
      }
      count++;
      const key = `up-${++uploadSeq}`;
      setUploads((list) => [...list, { key, name: file.name, size: file.size, progress: 0, attachment: null }]);
      upload.mutate(
        { file, opts: { onProgress: (f) => setUploads((list) => list.map((u) => (u.key === key ? { ...u, progress: f } : u))) } },
        {
          onSuccess: (a) => setUploads((list) => list.map((u) => (u.key === key ? { ...u, progress: 1, attachment: a } : u))),
          onError: (e) => {
            setUploads((list) => list.filter((u) => u.key !== key));
            setFailed(`${file.name}: ${helpErrorText(e, 'Upload failed.')}`);
          },
        },
      );
    }
    setFailed(problems.length ? problems.join(' ') : null);
    if (fileInput.current) fileInput.current.value = '';
  };

  const submit = handleSubmit((v) => {
    setFailed(null);
    create.mutate(
      {
        category: v.category,
        subject: v.subject.trim(),
        description: v.description.trim(),
        priority: v.priority,
        order_id: showOrders ? (order?.id ?? null) : null,
        attachment_ids: uploads.flatMap((u) => (u.attachment ? [u.attachment.id] : [])),
        client_id: clientId,
      },
      {
        onSuccess: (t) => onCreated(t),
        onError: (e) => setFailed(helpErrorText(e, 'Couldn’t send your ticket.')),
      },
    );
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="New support ticket"
      description="Tell us what happened. Attach the order so we can look at it directly."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={readOnly || uploading} loading={create.isPending}>
            Submit ticket
          </Button>
        </>
      }
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-5"
      >
        {failed && (
          <HelpBanner tone="danger" action={create.isError ? <BannerButton onClick={() => void submit()}>Try again</BannerButton> : undefined}>
            {create.isError ? `Couldn’t send your ticket. ${failed} Your text and files are kept — try again.` : failed}
          </HelpBanner>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Select label="Category" error={errors.category?.message} defaultValue="" {...register('category')}>
            <option value="" disabled>
              Choose a category
            </option>
            {SUPPORT_TICKET_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {SUPPORT_TICKET_CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
          <Input label="Subject" maxLength={SUPPORT_LIMITS.subject} error={errors.subject?.message} {...register('subject')} />
        </div>

        {showOrders && <OrderPicker value={order} onChange={setOrder} />}

        <div className="flex flex-col gap-1.5">
          <label htmlFor={descId} className="text-body font-medium text-text-primary">
            What happened?
          </label>
          <textarea
            id={descId}
            rows={4}
            maxLength={SUPPORT_LIMITS.body}
            aria-invalid={errors.description ? true : undefined}
            placeholder="What did you try, what did you expect, and what happened instead?"
            className={cn(
              'w-full rounded-control border bg-surface-card px-3.5 py-3 text-body text-text-primary outline-none placeholder:text-text-muted focus:border-brand-600 focus:shadow-focus',
              errors.description ? 'border-danger' : 'border-border-default',
            )}
            {...register('description')}
          />
          {errors.description && <p className="text-caption text-danger">{errors.description.message}</p>}
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-body font-medium text-text-primary">Attachments</span>
          <div className="flex flex-wrap items-center gap-2">
            {uploads.map((u) => (
              <span key={u.key} className="flex max-w-full items-center gap-2 rounded-md bg-surface-subtle px-3 py-2">
                <FileText aria-hidden className="size-4 shrink-0 text-text-secondary" />
                <span className="min-w-0 truncate text-body font-medium text-text-primary">{u.name}</span>
                <span className="shrink-0 text-caption text-text-muted">{u.attachment ? formatBytes(u.size) : `${Math.round(u.progress * 100)}%`}</span>
                <button
                  type="button"
                  aria-label={`Remove ${u.name}`}
                  onClick={() => setUploads((list) => list.filter((x) => x.key !== u.key))}
                  className="rounded text-text-muted outline-none hover:text-text-primary focus-visible:shadow-focus"
                >
                  <X aria-hidden className="size-4" />
                </button>
              </span>
            ))}
            {uploads.length < SUPPORT_LIMITS.attachmentsPerMessage && (
              <button
                type="button"
                disabled={readOnly}
                onClick={() => fileInput.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  addFiles(e.dataTransfer.files);
                }}
                className="flex items-center gap-2 rounded-md border border-dashed border-border-strong px-4 py-2 text-caption font-medium text-brand-600 outline-none hover:bg-brand-50 focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Plus aria-hidden className="size-4" />
                Add files · PNG, JPG, PDF up to 10 MB
              </button>
            )}
            <input ref={fileInput} type="file" multiple accept={ATTACHMENT_ACCEPT} className="sr-only" aria-label="Add files" onChange={(e) => addFiles(e.target.files)} />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span id={`${descId}-prio`} className="text-body font-medium text-text-primary">
            Priority
          </span>
          <Controller
            control={control}
            name="priority"
            render={({ field }) => (
              <div role="group" aria-labelledby={`${descId}-prio`} className="flex flex-wrap gap-2">
                {merchantPriorities.map((p) => (
                  <Chip key={p} check={false} selected={field.value === p} onClick={() => field.onChange(p)}>
                    {p === 'urgent' ? 'Urgent — money or orders blocked' : PRIORITY_LABELS[p]}
                  </Chip>
                ))}
              </div>
            )}
          />
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/** Related order combobox: searches `GET /stores/{store}/orders?q=` (5 rows), shows number, customer, total, status. */
function OrderPicker({ value, onChange }: { value: OrderSummary | null; onChange: (o: OrderSummary | null) => void }) {
  const { storeId, tenantId } = useStoreScope();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [openList, setOpenList] = useState(false);
  const listId = useId();
  const inputId = useId();
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const results = useQuery({
    queryKey: [tenantId, storeId, 'orders', 'help-picker', debounced],
    queryFn: () => api.orders.list(storeId!, { q: debounced || undefined, per_page: 5, sort: '-placed_at' }),
    enabled: !!storeId && openList,
    retry: false,
  });
  const rows = results.data?.data ?? [];

  return (
    <div className="relative flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-body font-medium text-text-primary">
        Related order <span className="font-normal text-text-muted">(optional)</span>
      </label>
      {value ? (
        <div className="flex items-center gap-3 rounded-control border border-border-default bg-surface-card px-3.5 py-2.5">
          <span className="text-body font-semibold text-text-primary">{value.number}</span>
          <span className="min-w-0 flex-1 truncate text-body text-text-secondary">{value.customer.name}</span>
          <span className="text-body text-text-primary">{formatBdt(value.total_amount)}</span>
          <button type="button" aria-label="Remove related order" onClick={() => onChange(null)} className="rounded text-text-muted outline-none hover:text-text-primary focus-visible:shadow-focus">
            <X aria-hidden className="size-4" />
          </button>
        </div>
      ) : (
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-text-muted" />
          <input
            id={inputId}
            role="combobox"
            aria-expanded={openList}
            aria-controls={listId}
            aria-autocomplete="list"
            value={q}
            placeholder="Search order number or customer"
            onFocus={() => setOpenList(true)}
            onBlur={() => setTimeout(() => setOpenList(false), 150)}
            onChange={(e) => {
              setQ(e.target.value);
              setOpenList(true);
            }}
            className="h-11 w-full rounded-control border border-border-default bg-surface-card pr-3.5 pl-10 text-body text-text-primary outline-none placeholder:text-text-muted focus:border-brand-600 focus:shadow-focus"
          />
          {openList && (
            <ul id={listId} role="listbox" aria-label="Orders" className="absolute inset-x-0 top-full z-10 mt-1 flex max-h-64 flex-col overflow-y-auto rounded-lg border border-border-default bg-surface-card p-1 shadow-elevation-1">
              {results.isPending && <li className="px-3 py-2.5 text-caption text-text-muted">Searching orders…</li>}
              {results.isError && <li className="px-3 py-2.5 text-caption text-danger">We couldn’t load your orders.</li>}
              {!results.isPending && !results.isError && rows.length === 0 && <li className="px-3 py-2.5 text-caption text-text-muted">No orders match.</li>}
              {rows.map((o) => (
                <li
                  key={o.id}
                  role="option"
                  aria-selected={false}
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onChange(o);
                    setOpenList(false);
                    setQ('');
                  }}
                  className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 hover:bg-brand-50"
                >
                  <span className="text-body font-semibold text-text-primary">{o.number}</span>
                  <span className="min-w-0 flex-1 truncate text-body text-text-secondary">{o.customer.name}</span>
                  <span className="hidden text-body text-text-primary sm:inline">{formatBdt(o.total_amount)}</span>
                  <OrderStatusBadge status={o.status} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Host helper: modal + "Ticket T-n sent" banner with View ticket (2130:965). */
export function useNewTicket(defaults?: NewTicketDefaults) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState<SupportTicket | null>(null);
  const banner = sent ? (
    <HelpBanner tone="success" action={<BannerButton onClick={() => void navigate(`/help/tickets/${sent.id}`)}>View ticket</BannerButton>}>
      Ticket {sent.reference} sent. We’ll reply here and by email.
    </HelpBanner>
  ) : null;
  const modal = (
    <NewTicketModal
      open={open}
      defaults={defaults}
      onClose={() => setOpen(false)}
      onCreated={(t) => {
        setOpen(false);
        setSent(t);
      }}
    />
  );
  return { open: () => setOpen(true), banner, modal };
}
