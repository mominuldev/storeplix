import type { InboxAttachment, InboxChannel, InboxMergeTag, InboxSavedReply } from '@storeplix/types';
import { INBOX_LIMITS } from '@storeplix/types';
import { Button, cn, Spinner } from '@storeplix/ui';
import { FileText, Image as ImageIcon, Lock, Paperclip, X } from 'lucide-react';
import { useId, useMemo, useRef, useState } from 'react';
import { toast } from '../online-store/components/Toast';
import { inboxErrorText } from './errors';
import { attachmentProblem, matchSavedReplies, remainingTags, replaceRange, SENDS_TO, slashQuery } from './inbox';
import { useRenderSavedReply, useSavedReplies, useUploadAttachment } from './queries';

// PHASE-8-8E §6.2 + §8, Figma composer (2118:51165, mobile 2124:1509): Reply / Internal note toggle, "Sends to …",
// saved-reply chips, `/` search (server-rendered merge tags; unresolved tags block Send), paperclip + image uploads
// (JPG/PNG/PDF ≤ 5 MB, ≤ 3, with progress), Send. Enter sends, Shift+Enter adds a line.

export interface ComposerSend {
  kind: 'reply' | 'note';
  body: string;
  attachments: InboxAttachment[];
  saved_reply_id: string | null;
}

interface Upload {
  key: string;
  name: string;
  progress: number;
  attachment: InboxAttachment | null;
}

let uploadSeq = 0;

export function Composer({
  conversationId,
  channel,
  disabled,
  disabledReason,
  onSend,
}: {
  conversationId: string;
  channel: InboxChannel;
  disabled?: boolean;
  disabledReason?: string;
  onSend: (v: ComposerSend) => void;
}) {
  const [kind, setKind] = useState<'reply' | 'note'>('reply');
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [savedReplyId, setSavedReplyId] = useState<string | null>(null);
  const [unresolved, setUnresolved] = useState<InboxMergeTag[]>([]);
  const [hl, setHl] = useState({ q: '', i: 0 });
  const [slashClosed, setSlashClosed] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const listId = useId();

  const saved = useSavedReplies({}, !disabled);
  const render = useRenderSavedReply(conversationId);
  const upload = useUploadAttachment();
  const replies = useMemo(() => saved.data?.data ?? [], [saved.data]);
  const chips = replies.filter((r) => r.show_as_chip);

  const slash = slashClosed ? null : slashQuery(text, caret);
  const matches = slash ? matchSavedReplies(replies, slash.query) : [];
  const showSlash = !!slash && !disabled;
  // the highlighted option resets whenever the `/query` changes
  const highlight = slash && hl.q === slash.query ? hl.i : 0;
  const setHighlight = (f: (i: number) => number) => setHl({ q: slash?.query ?? '', i: f(highlight) });

  const blockedTags = remainingTags(text, unresolved);
  const uploading = uploads.some((u) => !u.attachment);
  const ready = uploads.flatMap((u) => (u.attachment ? [u.attachment] : []));
  const tooLong = text.length > INBOX_LIMITS.body_max;
  const canSend = !disabled && !uploading && !tooLong && blockedTags.length === 0 && (text.trim().length > 0 || ready.length > 0);

  const setTextAt = (next: string, nextCaret: number) => {
    setText(next);
    setCaret(nextCaret);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const insertSaved = (r: InboxSavedReply, range: { start: number; end: number } | null) => {
    render.mutate(r.id, {
      onSuccess: (out) => {
        const at = range ?? { start: area.current?.selectionStart ?? text.length, end: area.current?.selectionEnd ?? text.length };
        const res = replaceRange(text, at.start, at.end, out.body);
        setTextAt(res.text, res.caret);
        setSavedReplyId(r.id);
        setUnresolved((u) => [...new Set([...u, ...out.unresolved])]);
        const att = out.attachment;
        if (att) setUploads((list) => (list.length >= INBOX_LIMITS.attachments_per_message ? list : [...list, { key: `sr-${att.id}`, name: att.filename, progress: 1, attachment: att }]));
      },
      onError: (e) => toast(inboxErrorText(e, 'We couldn’t insert that saved reply.'), 'error'),
    });
  };

  const pickSlash = (r: InboxSavedReply) => {
    if (!slash) return;
    setSlashClosed(true);
    insertSaved(r, { start: slash.start, end: caret });
  };

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    let count = uploads.length;
    for (const file of Array.from(files)) {
      const problem = attachmentProblem(file, count);
      if (problem) {
        toast(`${file.name}: ${problem}`, 'error');
        continue;
      }
      count++;
      const key = `up-${++uploadSeq}`;
      setUploads((list) => [...list, { key, name: file.name, progress: 0, attachment: null }]);
      upload.mutate(
        { file, opts: { onProgress: (f) => setUploads((list) => list.map((u) => (u.key === key ? { ...u, progress: f } : u))) } },
        {
          onSuccess: (a) => setUploads((list) => list.map((u) => (u.key === key ? { ...u, progress: 1, attachment: a } : u))),
          onError: (e) => {
            setUploads((list) => list.filter((u) => u.key !== key));
            toast(`${file.name}: ${inboxErrorText(e, 'Upload failed.')}`, 'error');
          },
        },
      );
    }
  };

  const send = () => {
    if (!canSend) return;
    onSend({ kind, body: text.trim(), attachments: ready, saved_reply_id: savedReplyId });
    setText('');
    setCaret(0);
    setUploads([]);
    setSavedReplyId(null);
    setUnresolved([]);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSlash && matches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((h) => (h + 1) % matches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => (h - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickSlash(matches[highlight] ?? matches[0]!);
        return;
      }
    }
    if (showSlash && e.key === 'Escape') {
      e.preventDefault();
      setSlashClosed(true);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const note = kind === 'note';
  return (
    <div className={cn('flex flex-col gap-2.5 border-t border-border-default px-4 pt-3 pb-4 sm:px-5', note ? 'bg-warning-bg/50' : 'bg-surface-card')}>
      <div className="flex items-center gap-2">
        <div role="radiogroup" aria-label="Message type" className="flex items-center gap-1">
          <ModeButton selected={!note} onClick={() => setKind('reply')} disabled={disabled}>
            Reply
          </ModeButton>
          <ModeButton selected={note} onClick={() => setKind('note')} disabled={disabled}>
            <Lock aria-hidden className="size-3.5" /> Internal note
          </ModeButton>
        </div>
        <span className="ml-auto truncate text-caption text-text-muted">{note ? 'Only your team sees this' : SENDS_TO[channel]}</span>
      </div>

      {chips.length > 0 && !disabled && (
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] sm:-mx-5 sm:px-5" aria-label="Saved replies">
          {chips.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => insertSaved(r, null)}
              className="shrink-0 rounded-full border border-border-default bg-surface-card px-3.5 py-2 text-body text-text-primary outline-none hover:bg-surface-subtle focus-visible:shadow-focus"
            >
              {r.title}
            </button>
          ))}
        </div>
      )}

      {uploads.length > 0 && (
        <ul aria-label="Attachments" className="flex flex-wrap gap-2">
          {uploads.map((u) => (
            <li key={u.key} className="flex max-w-56 items-center gap-2 rounded-lg border border-border-default bg-surface-card py-1.5 pr-1.5 pl-2.5 text-caption">
              {u.attachment?.kind === 'image' ? <ImageIcon aria-hidden className="size-3.5 shrink-0" /> : <FileText aria-hidden className="size-3.5 shrink-0" />}
              <span className="min-w-0 flex-1 truncate">{u.name}</span>
              {!u.attachment && (
                <span className="flex items-center gap-1 text-text-muted" aria-label={`Uploading ${Math.round(u.progress * 100)}%`}>
                  <Spinner className="size-3" /> {Math.round(u.progress * 100)}%
                </span>
              )}
              <button type="button" aria-label={`Remove ${u.name}`} onClick={() => setUploads((l) => l.filter((x) => x.key !== u.key))} className="rounded-sm p-0.5 hover:bg-surface-subtle">
                <X aria-hidden className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="relative">
        {showSlash && (
          <ul id={listId} role="listbox" aria-label="Saved replies" className="absolute bottom-full left-0 z-20 mb-2 flex max-h-64 w-full max-w-md flex-col overflow-y-auto rounded-lg border border-border-default bg-surface-card p-1 shadow-elevation-1">
            {saved.isPending && <li className="px-3 py-2 text-caption text-text-muted">Loading saved replies…</li>}
            {saved.isSuccess && matches.length === 0 && <li className="px-3 py-2 text-caption text-text-muted">No saved reply matches “/{slash?.query}”.</li>}
            {matches.map((r, i) => (
              <li key={r.id} role="option" aria-selected={i === highlight}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickSlash(r)}
                  className={cn('flex w-full flex-col items-start rounded-md px-3 py-2 text-left', i === highlight ? 'bg-brand-50' : 'hover:bg-surface-subtle')}
                >
                  <span className="text-body font-medium text-text-primary">
                    {r.title} <span className="font-normal text-text-muted">/{r.shortcut}</span>
                  </span>
                  <span className="line-clamp-1 text-caption text-text-secondary">{r.body}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className={cn('flex items-end gap-2 rounded-card border bg-surface-card px-3 py-2', note ? 'border-warning' : 'border-border-default', 'focus-within:shadow-focus')}>
          <button type="button" aria-label="Attach photo or PDF" disabled={disabled} onClick={() => fileInput.current?.click()} className="mb-1.5 rounded-md p-1 text-text-secondary hover:bg-surface-subtle disabled:opacity-50">
            <Paperclip aria-hidden className="size-[18px]" />
          </button>
          <button type="button" aria-label="Attach photo" disabled={disabled} onClick={() => imageInput.current?.click()} className="mb-1.5 rounded-md p-1 text-text-secondary hover:bg-surface-subtle disabled:opacity-50">
            <ImageIcon aria-hidden className="size-[18px]" />
          </button>
          <input ref={fileInput} type="file" hidden accept="image/jpeg,image/png,application/pdf" multiple onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} data-testid="composer-file" />
          <input ref={imageInput} type="file" hidden accept="image/jpeg,image/png" multiple onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} />
          <textarea
            ref={area}
            rows={1}
            value={text}
            disabled={disabled}
            aria-label={note ? 'Internal note' : 'Reply'}
            aria-controls={showSlash ? listId : undefined}
            aria-autocomplete="list"
            placeholder={disabled ? (disabledReason ?? 'You can’t reply here') : note ? 'Write a note for your team…' : 'Reply… / for saved replies'}
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart);
              setSlashClosed(false);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            className="max-h-40 min-h-9 flex-1 resize-none bg-transparent py-1.5 text-body text-text-primary outline-none [field-sizing:content] placeholder:text-text-muted disabled:cursor-not-allowed"
          />
          <Button size="sm" onClick={send} disabled={!canSend} loading={render.isPending} className="mb-0.5">
            Send
          </Button>
        </div>
      </div>
      {blockedTags.length > 0 && (
        <p role="alert" className="text-caption text-danger">
          Replace {blockedTags.map((t) => `{${t}}`).join(', ')} before sending — there’s no value for this conversation.
        </p>
      )}
      {tooLong && <p role="alert" className="text-caption text-danger">Messages can be up to {INBOX_LIMITS.body_max.toLocaleString('en-US')} characters.</p>}
    </div>
  );
}

function ModeButton({ selected, onClick, disabled, children }: { selected: boolean; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-caption font-medium outline-none focus-visible:shadow-focus disabled:opacity-60',
        selected ? 'bg-brand-50 text-brand-700' : 'text-text-secondary hover:bg-surface-subtle',
      )}
    >
      {children}
    </button>
  );
}
