import { isApiError } from '@storeplix/api-client';
import type { Media, MediaPurpose, MediaRef } from '@storeplix/types';
import { Button, cn, Modal, Spinner } from '@storeplix/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Check, ImageIcon, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useMediaLibrary } from '../hooks';

// Figma V3 media picker 2053:51939 (hero image) / quick pick 2053:52607. Phase 3 builds "Media library" (GET /media)
// and "Upload from computer"; Recently used, Product photos, Take a photo, From a link, stock photos and folders
// are out of scope (no API) and not shown. Remote URLs are never accepted (contract P3-12, no SSRF surface).

const ACCEPT = 'image/png,image/jpeg,image/webp';
const MAX_BYTES = 10 * 1024 * 1024;

export interface PickedMedia {
  id: string;
  url: string;
  name?: string;
}

export function mediaThumb(m: Pick<Media, 'url' | 'variants'>): string {
  return m.variants?.find((v) => v.key === 'w320')?.url ?? m.variants?.[0]?.url ?? m.url;
}

export function refToPicked(ref: MediaRef | null | undefined): PickedMedia | null {
  return ref ? { id: ref.id, url: ref.url } : null;
}

export function MediaPicker({
  open,
  onClose,
  onPick,
  title = 'Choose an image',
  hint = 'JPG, PNG or WebP',
  purpose = 'page_image',
  currentId,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (media: PickedMedia) => void;
  title?: string;
  hint?: string;
  purpose?: Extract<MediaPurpose, 'page_image' | 'logo'>;
  currentId?: string | null;
}) {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Media | null>(null);
  const [uploading, setUploading] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const library = useMediaLibrary(purpose === 'logo' ? ['logo'] : ['page_image', 'product_image'], page, open);
  const items = library.data?.data ?? [];
  const meta = library.data?.meta as { last_page?: number } | undefined;

  const upload = async (file: File) => {
    setError(null);
    if (!ACCEPT.split(',').includes(file.type)) return setError('Use a JPG, PNG or WebP image.');
    if (file.size > MAX_BYTES) return setError('This file is too large — the limit is 10 MB.');
    setUploading(0);
    try {
      let media = await api.media.upload({ file, purpose }, { onProgress: setUploading });
      if (media.status === 'processing') media = await api.media.waitUntilProcessed(media);
      if (media.status !== 'ready') {
        setError(media.status === 'failed' ? 'We couldn’t process this image. Try a different file.' : 'Processing is taking longer than usual. Try again in a minute.');
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ['media'] });
      setSelected(media);
    } catch (e) {
      setError(isApiError(e) ? (e.fieldError('file') ?? e.message) : 'Upload failed. Please try again.');
    } finally {
      setUploading(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={`Best size: ${hint}`}
      className="max-w-[880px]"
      footer={
        <>
          <span className="mr-auto hidden truncate text-caption text-text-secondary sm:block">{selected ? `${selected.alt ?? 'Image'} selected` : 'Pick an image or upload a new one'}</span>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!selected}
            onClick={() => {
              if (!selected) return;
              onPick({ id: selected.id, url: mediaThumb(selected), name: selected.alt ?? undefined });
              onClose();
            }}
          >
            Use this image
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const file = e.dataTransfer.files[0];
            if (file) void upload(file);
          }}
          className="flex items-center gap-3 rounded-lg border border-dashed border-brand-500 bg-brand-50 px-4 py-3"
        >
          <Upload aria-hidden className="size-5 shrink-0 text-brand-600" />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-body font-medium text-text-primary">
              Drag & drop a photo here, or{' '}
              <button type="button" className="font-semibold text-brand-600 underline-offset-2 hover:underline" onClick={() => inputRef.current?.click()}>
                browse
              </button>
            </span>
            <span className="text-caption text-text-muted">JPG, PNG or WebP up to 10 MB</span>
          </div>
          {uploading !== null && <Spinner size="sm" label={`Uploading ${Math.round(uploading * 100)}%`} />}
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            className="sr-only"
            aria-label="Upload from computer"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void upload(file);
            }}
          />
        </div>
        {error && (
          <p role="alert" className="text-caption text-danger">
            {error}
          </p>
        )}
        {library.isPending ? (
          <div className="flex h-40 items-center justify-center">
            <Spinner label="Loading your images" />
          </div>
        ) : library.isError ? (
          <p className="text-body text-text-secondary">We couldn’t load your images. Upload a new one instead.</p>
        ) : items.length === 0 ? (
          <div className="flex h-32 flex-col items-center justify-center gap-2 text-text-muted">
            <ImageIcon aria-hidden className="size-6" />
            <span className="text-body">No images yet — upload your first one.</span>
          </div>
        ) : (
          <ul aria-label="Media library" className="grid max-h-[52dvh] grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-4">
            {items.map((m) => {
              const active = selected?.id === m.id;
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    aria-pressed={active}
                    aria-label={m.alt ?? `Image ${m.id.slice(-6)}`}
                    onClick={() => setSelected(m)}
                    className={cn(
                      'relative block aspect-[4/3] w-full overflow-hidden rounded-lg bg-surface-subtle outline-none focus-visible:shadow-focus',
                      active && 'shadow-[0_0_0_2px_var(--color-brand-600)]',
                    )}
                  >
                    <img src={mediaThumb(m)} alt="" loading="lazy" className="size-full object-cover" />
                    {m.id === currentId && <span className="absolute top-1.5 left-1.5 rounded-sm bg-text-primary/80 px-1.5 py-0.5 text-[10px] text-text-inverse">In use now</span>}
                    {active && (
                      <span className="absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full bg-brand-600 text-text-inverse">
                        <Check aria-hidden className="size-3.5" />
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {(meta?.last_page ?? 1) > 1 && (
          <div className="flex items-center justify-end gap-2">
            <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <Button size="sm" variant="secondary" disabled={page >= (meta?.last_page ?? 1)} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Compact "thumb · name · Replace/Remove" row (V3 right panel 2045:48496). */
export function ImageField({
  label,
  value,
  onChange,
  disabled,
  title,
  hint,
}: {
  label: string;
  value: PickedMedia | null;
  onChange: (value: PickedMedia | null) => void;
  disabled?: boolean;
  title?: string;
  hint?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-caption font-medium text-text-secondary">{label}</span>
      <div className="flex items-center gap-2.5">
        <span className="flex h-9 w-12 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-accent-100">
          {value ? <img src={value.url} alt="" className="size-full object-cover" /> : <ImageIcon aria-hidden className="size-4 text-text-muted" />}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-text-primary">{value ? (value.name ?? 'Your image') : 'Theme sample image'}</span>
        {!disabled && (
          <>
            {value && (
              <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
                Remove
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
              {value ? 'Replace' : 'Choose'}
            </Button>
          </>
        )}
      </div>
      {open && <MediaPicker open onClose={() => setOpen(false)} onPick={onChange} title={title ?? `Choose image · ${label}`} hint={hint} currentId={value?.id} />}
    </div>
  );
}
