'use client';

import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { INBOX_COPY, tr, type Lang } from '@/lib/inbox-copy';
import { ATTACHMENT_ACCEPT, SHOPPER_BODY_MAX, attachmentProblem, cleanBody, formatFileSize, type AttachmentProblem } from '@/lib/inbox-shared';
import { Icon } from '@/themes/modern-commerce/components/icon';

export function attachmentProblemText(p: AttachmentProblem, lang: Lang): string {
  return tr(p === 'size' ? INBOX_COPY.fileSize : p === 'empty' ? INBOX_COPY.fileEmpty : INBOX_COPY.fileType, lang);
}

/** Picked-file chip with a remove button. */
export function FileChip({ file, onRemove, lang }: { file: File; onRemove: () => void; lang: Lang }) {
  return (
    <span className="type-label-s flex max-w-full items-center gap-2 self-start rounded-sf-md bg-sunken py-1.5 pr-1.5 pl-2.5 text-ink" data-sp-chat-file>
      <Icon name="paperclip" size={16} className="text-brand" />
      <span className="min-w-0 truncate">{file.name}</span>
      <span className="text-ink-muted">{formatFileSize(file.size)}</span>
      <button type="button" onClick={onRemove} aria-label={tr(INBOX_COPY.removeFile(file.name), lang)} className="grid size-7 place-items-center rounded-full hover:bg-ink/5">
        <Icon name="x" size={14} />
      </button>
    </span>
  );
}

interface Props {
  variant: 'chat' | 'card';
  lang: Lang;
  /** external error (send failure, offline) shown under the field */
  error: string | null;
  disabled?: boolean;
  onSend: (body: string, file: File | null) => Promise<boolean> | boolean;
  onInteract?: () => void;
}

/**
 * Thread composer. `chat` = widget bar (paperclip · input · round send, Figma 2125:10004); `card` = order Messages
 * (textarea, "Attach photo or PDF", **Send**, Figma 2126:10642). JPG/PNG/PDF ≤ 5 MB checked before sending.
 */
export function Composer({ variant, lang, error, disabled = false, onSend, onInteract }: Props) {
  const [body, setBody] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const errId = useId();
  const fieldId = useId();
  const shown = fileError ?? error;
  const tooLong = [...body].length > SHOPPER_BODY_MAX;
  const canSend = !disabled && !busy && !tooLong && (cleanBody(body).length > 0 || file !== null);

  const pick = (f: File | undefined) => {
    onInteract?.();
    if (!f) return;
    const problem = attachmentProblem(f);
    setFileError(problem ? attachmentProblemText(problem, lang) : null);
    setFile(problem ? null : f);
    if (fileRef.current) fileRef.current.value = '';
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!canSend) return;
    const text = cleanBody(body);
    const f = file;
    setBusy(true);
    setBody('');
    setFile(null);
    setFileError(null);
    try {
      await onSend(text, f);
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    onInteract?.();
    if (variant === 'chat' && e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const fileInput = (
    <input ref={fileRef} type="file" accept={ATTACHMENT_ACCEPT} className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => pick(e.target.files?.[0])} />
  );
  const errorLine = shown || tooLong ? (
    <p id={errId} role="alert" className="type-body-s text-sale" data-sp-chat-error>
      {tooLong ? tr(INBOX_COPY.messageTooLong(SHOPPER_BODY_MAX), lang) : shown}
    </p>
  ) : null;

  if (variant === 'chat') {
    return (
      <form onSubmit={submit} className="flex flex-col gap-2 border-t border-line bg-surface py-3 pr-3 pl-4" data-sp-chat-composer>
        {file ? <FileChip file={file} onRemove={() => setFile(null)} lang={lang} /> : null}
        {errorLine}
        <div className="flex items-center gap-2.5">
          {fileInput}
          <button type="button" onClick={() => fileRef.current?.click()} disabled={disabled} aria-label={tr(INBOX_COPY.attach, lang)} className="grid size-8 shrink-0 place-items-center rounded-full text-ink-secondary hover:bg-ink/5 disabled:opacity-50">
            <Icon name="paperclip-lg" />
          </button>
          <label htmlFor={fieldId} className="sr-only">
            {tr(INBOX_COPY.message, lang)}
          </label>
          <textarea
            id={fieldId}
            rows={1}
            value={body}
            disabled={disabled}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={onKey}
            placeholder={tr(INBOX_COPY.composer, lang)}
            aria-invalid={tooLong || undefined}
            aria-describedby={shown || tooLong ? errId : undefined}
            className="type-body-m max-h-28 min-h-[25px] min-w-0 flex-1 resize-none bg-transparent text-ink outline-none placeholder:text-ink-muted [field-sizing:content]"
          />
          <button type="submit" disabled={!canSend} aria-label={tr(INBOX_COPY.sendShort, lang)} className="grid size-[38px] shrink-0 place-items-center rounded-full bg-brand text-on-brand hover:brightness-110 disabled:opacity-50">
            <Icon name="paper-plane-right" />
          </button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" data-sp-chat-composer>
      <label htmlFor={fieldId} className="sr-only">
        {tr(INBOX_COPY.message, lang)}
      </label>
      <textarea
        id={fieldId}
        rows={3}
        value={body}
        disabled={disabled}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKey}
        placeholder={tr(INBOX_COPY.orderPlaceholder, lang)}
        aria-invalid={tooLong || undefined}
        aria-describedby={shown || tooLong ? errId : undefined}
        className="type-body-s w-full resize-y rounded-sf-md border border-line bg-surface p-3 text-ink outline-none placeholder:text-ink-muted focus:border-2 focus:border-brand"
      />
      {file ? <FileChip file={file} onRemove={() => setFile(null)} lang={lang} /> : null}
      {errorLine}
      <div className="flex items-center justify-between gap-3">
        {fileInput}
        <button type="button" onClick={() => fileRef.current?.click()} disabled={disabled} className="type-label-s flex items-center gap-2 text-brand hover:underline disabled:opacity-50">
          <Icon name="paperclip" size={16} />
          {tr(INBOX_COPY.orderAttach, lang)}
        </button>
        <button type="submit" disabled={!canSend} className="type-label-m flex h-10 items-center gap-2 rounded-control bg-brand px-5 text-on-brand hover:brightness-110 disabled:opacity-50">
          {tr(INBOX_COPY.sendShort, lang)}
          <Icon name="paper-plane-right" />
        </button>
      </div>
    </form>
  );
}
