import type { InboxAttachment, InboxMergeTag, InboxSavedReply, InboxSavedReplyFilters } from '@storeplix/types';
import { INBOX_LIMITS, INBOX_MERGE_TAG_LABELS, INBOX_MERGE_TAGS, INBOX_SHORTCUT_PATTERN } from '@storeplix/types';
import { isApiError } from '@storeplix/api-client';
import { Badge, Button, buttonVariants, Chip, cn, Dialog, formatCount, gripProps, Input, Skeleton, SortableList, Spinner, Toggle } from '@storeplix/ui';
import { FileText, GripVertical, Image as ImageIcon, Paperclip, Pencil, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { z } from 'zod';
import { ErrorBlock, NoResults } from '../catalog/states';
import { useReadOnly } from '../impersonation/hooks';
import { toast } from '../online-store/components/Toast';
import { inboxErrorText } from './errors';
import { attachmentProblem, attachmentSub, insertTag, moveId, unknownTags } from './inbox';
import { useCreateSavedReply, useDeleteSavedReply, useReorderSavedReplies, useSavedReplies, useUpdateSavedReply, useUploadAttachment } from './queries';

// PHASE-8-8E §8, Figma 2123:52877: header (Back to Inbox / New reply); list card (search, chips All · n / Shown as
// chips · n / With attachment · n, drag-to-reorder rows: title, /shortcut, message, "Used n×", edit); editor card
// (title, shortcut, message + Insert merge-tag chips, optional attachment, "Show as a chip above the reply box",
// Delete / Cancel / Save). The "Suggest when a customer asks about delivery" toggle is hidden (8.8f, §18).

export const savedReplySchema = z.object({
  title: z.string().trim().min(1, 'Give the reply a title.').max(INBOX_LIMITS.saved_reply_title_max, 'Up to 60 characters.'),
  shortcut: z
    .string()
    .trim()
    .transform((s) => s.replace(/^\//, '').toLowerCase())
    .pipe(z.string().regex(INBOX_SHORTCUT_PATTERN, '2–24 letters, numbers, - or _.')),
  body: z
    .string()
    .trim()
    .min(1, 'Write the message.')
    .max(INBOX_LIMITS.saved_reply_body_max, 'Up to 1,000 characters.')
    .refine((b) => unknownTags(b).length === 0, { message: 'Use only the Insert chips for {tags}.' }),
});
type FormErrors = Partial<Record<'title' | 'shortcut' | 'body', string>>;

type Filter = 'all' | 'chips' | 'attachment';
const FILTERS: Record<Filter, InboxSavedReplyFilters> = { all: {}, chips: { chip: true }, attachment: { attachment: true } };

export function SavedRepliesPage() {
  const readOnly = useReadOnly();
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const filters = useMemo(() => ({ ...FILTERS[filter], q: debounced || undefined }), [filter, debounced]);
  const list = useSavedReplies(filters);
  const reorder = useReorderSavedReplies();
  const [editing, setEditing] = useState<InboxSavedReply | 'new' | null>(null);
  const rows = list.data?.data ?? [];
  const counts = list.data?.meta.counts;
  const canReorder = !readOnly && filter === 'all' && !debounced;

  const onMove = (from: number, to: number) => {
    const ids = moveId(
      rows.map((r) => r.id),
      from,
      to,
    );
    reorder.mutate(ids, { onError: (e) => toast(inboxErrorText(e, 'We couldn’t save the new order.'), 'error') });
  };

  const row = (r: InboxSavedReply, handle?: Parameters<typeof gripProps>[0]) => (
    <div className={cn('flex items-start gap-3 rounded-lg px-3 py-3', editing !== 'new' && editing?.id === r.id ? 'bg-brand-50' : 'hover:bg-surface-subtle')}>
      {handle ? (
        <button type="button" aria-label={`Drag ${r.title}`} className="mt-0.5 cursor-grab touch-none rounded-sm p-0.5 text-text-muted" {...gripProps(handle)}>
          <GripVertical aria-hidden className="size-4" />
        </button>
      ) : (
        <span className="w-5" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body font-medium text-text-primary">{r.title}</span>
          <Badge size="sm">/{r.shortcut}</Badge>
          {r.attachment && <Paperclip aria-label="Has an attachment" className="size-3.5 text-text-muted" />}
          {r.show_as_chip && (
            <Badge tone="brand" size="sm">
              Chip
            </Badge>
          )}
        </div>
        <p className="line-clamp-2 text-caption text-text-secondary">{r.body}</p>
      </div>
      <span className="shrink-0 text-caption text-text-muted">Used {formatCount(r.use_count)}×</span>
      <button type="button" aria-label={`Edit ${r.title}`} onClick={() => setEditing(r)} className="shrink-0 rounded-md p-1 text-text-secondary hover:bg-surface-card">
        <Pencil aria-hidden className="size-4" />
      </button>
    </div>
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-heading-24 text-text-primary">Saved replies</h1>
          <p className="text-body text-text-secondary">Answers your team sends in one tap, or by typing / in the reply box. Shared with everyone who can use the Inbox.</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Link to="/inbox" className={buttonVariants({ variant: 'secondary' })}>
            Back to Inbox
          </Link>
          <Button disabled={readOnly} onClick={() => setEditing('new')}>
            New reply
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
        <section aria-label="Saved replies list" className={cn('flex min-w-0 flex-1 flex-col gap-4 rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1', editing && 'hidden lg:flex')}>
          <div className="flex flex-col gap-3 md:flex-row md:items-center">
            <label className="flex items-center gap-2 rounded-lg bg-surface-subtle px-3 py-2.5 md:w-56">
              <Search aria-hidden className="size-4 text-text-muted" />
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search replies" aria-label="Search replies" className="min-w-0 flex-1 bg-transparent text-body outline-none" />
            </label>
            <div role="group" aria-label="Filter" className="flex flex-wrap gap-1.5">
              {(['all', 'chips', 'attachment'] as Filter[]).map((f) => (
                <Chip key={f} check={false} selected={filter === f} onClick={() => setFilter(f)}>
                  {f === 'all' ? 'All' : f === 'chips' ? 'Shown as chips' : 'With attachment'}
                  {counts && ` · ${formatCount(f === 'all' ? counts.all : f === 'chips' ? counts.chips : counts.with_attachment)}`}
                </Chip>
              ))}
            </div>
          </div>
          {list.isPending ? (
            <div role="status" aria-label="Loading saved replies" className="flex flex-col gap-3">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-14 rounded-lg" />
              ))}
            </div>
          ) : list.isError ? (
            <ErrorBlock title="We couldn’t load saved replies" error={list.error} onRetry={() => void list.refetch()} />
          ) : rows.length === 0 ? (
            debounced || filter !== 'all' ? (
              <NoResults title="No saved replies match" onClear={() => (setQ(''), setFilter('all'))} clearLabel="Show all" />
            ) : (
              <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
                <h3 className="text-body-lg font-medium text-text-primary">No saved replies yet</h3>
                <p className="max-w-sm text-body text-text-secondary">Save the answers you send most — delivery charges, size charts, payment links — and insert them with /.</p>
                {!readOnly && (
                  <Button size="sm" onClick={() => setEditing('new')}>
                    New reply
                  </Button>
                )}
              </div>
            )
          ) : canReorder ? (
            <SortableList items={rows} onMove={onMove} label="Saved replies" className="divide-y divide-border-default gap-0" renderItem={(r, { handle }) => row(r, handle)} />
          ) : (
            <ul aria-label="Saved replies" className="flex flex-col divide-y divide-border-default">
              {rows.map((r) => (
                <li key={r.id}>{row(r)}</li>
              ))}
            </ul>
          )}
        </section>

        {editing && <SavedReplyEditor key={editing === 'new' ? 'new' : editing.id} reply={editing === 'new' ? null : editing} readOnly={readOnly} onDone={() => setEditing(null)} />}
      </div>
    </div>
  );
}

function SavedReplyEditor({ reply, readOnly, onDone }: { reply: InboxSavedReply | null; readOnly: boolean; onDone: () => void }) {
  const [title, setTitle] = useState(reply?.title ?? '');
  const [shortcut, setShortcut] = useState(reply ? `/${reply.shortcut}` : '/');
  const [body, setBody] = useState(reply?.body ?? '');
  const [chip, setChip] = useState(reply?.show_as_chip ?? false);
  const [attachment, setAttachment] = useState<InboxAttachment | null>(reply?.attachment ?? null);
  const [progress, setProgress] = useState<number | null>(null);
  const [errors, setErrors] = useState<FormErrors>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const create = useCreateSavedReply();
  const update = useUpdateSavedReply();
  const remove = useDeleteSavedReply();
  const upload = useUploadAttachment();
  const saving = create.isPending || update.isPending;

  const insert = (tag: InboxMergeTag) => {
    const el = area.current;
    const r = insertTag(body, tag, el?.selectionStart ?? body.length, el?.selectionEnd ?? body.length);
    setBody(r.body);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(r.caret, r.caret);
    });
  };

  const pickFile = (file: File | undefined) => {
    if (!file) return;
    const problem = attachmentProblem(file);
    if (problem) return toast(problem, 'error');
    setProgress(0);
    upload.mutate(
      { file, opts: { onProgress: setProgress } },
      {
        onSuccess: (a) => (setAttachment(a), setProgress(null)),
        onError: (e) => (setProgress(null), toast(inboxErrorText(e, 'Upload failed.'), 'error')),
      },
    );
  };

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = savedReplySchema.safeParse({ title, shortcut, body });
    if (!parsed.success) {
      const errs: FormErrors = {};
      for (const issue of parsed.error.issues) {
        const k = issue.path[0] as keyof FormErrors;
        errs[k] ??= issue.message;
      }
      return setErrors(errs);
    }
    setErrors({});
    const input = { ...parsed.data, show_as_chip: chip, attachment_id: attachment?.id ?? null };
    const onError = (err: unknown) => {
      if (isApiError(err) && err.code === 'saved_reply_shortcut_taken') return setErrors({ shortcut: inboxErrorText(err) });
      if (isApiError(err) && err.code === 'saved_reply_unknown_merge_tag') return setErrors({ body: inboxErrorText(err) });
      if (isApiError(err) && err.fieldErrors) {
        const fe = err.fieldErrors;
        return setErrors({ title: fe.title?.[0], shortcut: fe.shortcut?.[0], body: fe.body?.[0] });
      }
      toast(inboxErrorText(err), 'error');
    };
    const onSuccess = () => {
      toast(reply ? 'Saved reply updated.' : 'Saved reply added.');
      onDone();
    };
    if (reply) update.mutate({ id: reply.id, input: { ...input, revision: reply.revision } }, { onSuccess, onError });
    else create.mutate(input, { onSuccess, onError });
  };

  return (
    <section aria-label={reply ? `Edit ${reply.title}` : 'New saved reply'} className="flex w-full flex-col rounded-card border border-border-default bg-surface-card p-5 shadow-elevation-1 lg:w-[428px] lg:shrink-0">
      <form onSubmit={save} className="flex flex-col gap-4" noValidate>
        <h2 className="text-heading text-text-primary">{reply ? `Edit · ${reply.title}` : 'New saved reply'}</h2>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Title" error={errors.title}>
            <Input value={title} maxLength={60} disabled={readOnly} onChange={(e) => setTitle(e.target.value)} aria-invalid={!!errors.title} />
          </Field>
          <Field label="Shortcut" error={errors.shortcut}>
            <Input value={shortcut} maxLength={25} disabled={readOnly} onChange={(e) => setShortcut(e.target.value.startsWith('/') ? e.target.value : `/${e.target.value}`)} aria-invalid={!!errors.shortcut} />
          </Field>
        </div>
        <Field label="Message" error={errors.body}>
          <textarea
            ref={area}
            value={body}
            rows={4}
            maxLength={INBOX_LIMITS.saved_reply_body_max}
            disabled={readOnly}
            onChange={(e) => setBody(e.target.value)}
            aria-invalid={!!errors.body}
            className="rounded-md border border-border-default bg-surface-card px-3 py-2.5 text-body text-text-primary outline-none focus:shadow-focus disabled:bg-surface-subtle"
          />
        </Field>
        <div className="-mt-2 flex flex-wrap items-center gap-1.5" aria-label="Insert a merge tag">
          <span className="text-caption text-text-muted">Insert</span>
          {INBOX_MERGE_TAGS.map((t) => (
            <button
              key={t}
              type="button"
              disabled={readOnly}
              title={INBOX_MERGE_TAG_LABELS[t]}
              onClick={() => insert(t)}
              className="rounded-sm bg-brand-50 px-1.5 py-0.5 text-caption font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-60"
            >
              {`{${t}}`}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3 rounded-lg border border-dashed border-border-strong px-3 py-3">
          {attachment ? (
            <>
              {attachment.kind === 'image' ? <ImageIcon aria-hidden className="size-4 text-text-secondary" /> : <FileText aria-hidden className="size-4 text-text-secondary" />}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-body font-medium text-text-primary">{attachment.filename}</span>
                <span className="text-caption text-text-muted">{attachmentSub(attachment)} · sent with the reply</span>
              </span>
              {!readOnly && (
                <button type="button" aria-label="Remove attachment" onClick={() => setAttachment(null)} className="rounded-md p-1 text-text-secondary hover:bg-surface-subtle">
                  <X aria-hidden className="size-4" />
                </button>
              )}
            </>
          ) : (
            <button type="button" disabled={readOnly || progress !== null} onClick={() => fileInput.current?.click()} className="flex flex-1 items-center gap-3 text-left disabled:opacity-60">
              {progress !== null ? <Spinner className="size-4" /> : <Paperclip aria-hidden className="size-4 text-text-secondary" />}
              <span className="flex flex-col">
                <span className="text-body font-medium text-text-primary">{progress !== null ? `Uploading… ${Math.round(progress * 100)}%` : 'Attach an image or PDF'}</span>
                <span className="text-caption text-text-muted">Optional · JPG, PNG or PDF up to 5 MB · sent with the reply</span>
              </span>
            </button>
          )}
          <input ref={fileInput} type="file" hidden accept="image/jpeg,image/png,application/pdf" data-testid="saved-reply-file" onChange={(e) => (pickFile(e.target.files?.[0]), (e.target.value = ''))} />
        </div>

        <label className="flex items-center gap-3 text-body text-text-primary">
          <Toggle checked={chip} disabled={readOnly} onChange={setChip} label="Show as a chip above the reply box" />
          Show as a chip above the reply box
        </label>

        <div className="flex items-center gap-3 pt-1">
          {reply && !readOnly && (
            <Button type="button" variant="ghost" onClick={() => setConfirmDelete(true)}>
              Delete reply
            </Button>
          )}
          <span className="flex-1" />
          <Button type="button" variant="secondary" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" disabled={readOnly || progress !== null} loading={saving}>
            Save reply
          </Button>
        </div>
      </form>
      {reply && (
        <Dialog
          open={confirmDelete}
          title={`Delete “${reply.title}”?`}
          description="Your team can’t insert it any more. Messages already sent stay as they are."
          confirmLabel="Delete reply"
          tone="danger"
          loading={remove.isPending}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() =>
            remove.mutate(reply.id, {
              onSuccess: () => {
                toast('Saved reply deleted.');
                onDone();
              },
              onError: (e) => toast(inboxErrorText(e), 'error'),
            })
          }
        />
      )}
    </section>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-body font-medium text-text-primary">{label}</span>
      {children}
      {error && <span className="text-caption text-danger">{error}</span>}
    </label>
  );
}

export default SavedRepliesPage;
