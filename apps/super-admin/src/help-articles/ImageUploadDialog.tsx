import type { HelpMediaRef } from '@storeplix/types';
import { HELP_LIMITS } from '@storeplix/types';
import { Dialog, FileDrop, Input } from '@storeplix/ui';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { HELP_IMAGE_ACCEPT, imageFileProblem } from './doc';

// Image block (P89C-5/6): pick a file, write the alt text (required) and an optional caption, upload to platform help
// media; the editor inserts `{type: 'image', attrs: {media_id, alt, caption}}`.
export function ImageUploadDialog({ onClose, onInserted }: { onClose: () => void; onInserted: (ref: HelpMediaRef, alt: string, caption: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [alt, setAlt] = useState('');
  const [caption, setCaption] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const upload = useMutation({
    mutationFn: (f: File) => api.admin.help.uploadMedia({ file: f, filename: f.name, alt: alt.trim() }),
    onSuccess: (ref) => onInserted(ref, alt.trim(), caption.trim()),
  });
  const altError = tried && !alt.trim() ? 'Alt text is required' : undefined;

  return (
    <Dialog
      open
      title="Add image"
      description="PNG, JPG or WebP up to 5 MB. Screenshots are re-encoded and location data is removed."
      confirmLabel="Upload and insert"
      loading={upload.isPending}
      onConfirm={() => {
        setTried(true);
        if (!file) {
          setProblem('Choose an image first.');
          return;
        }
        if (!alt.trim()) return;
        upload.mutate(file);
      }}
      onCancel={onClose}
    >
      <div className="flex flex-col gap-4">
        <FileDrop
          accept={HELP_IMAGE_ACCEPT}
          label={file ? file.name : 'Drop an image or browse'}
          onFiles={(files: File[]) => {
            const f = files[0];
            if (!f) return;
            const p = imageFileProblem(f);
            setProblem(p);
            setFile(p ? null : f);
          }}
        />
        {problem && (
          <p role="alert" className="text-body text-danger">
            {problem}
          </p>
        )}
        <Input label="Alt text" hint="Describe what the image shows (up to 200 characters)" maxLength={HELP_LIMITS.imageAlt} value={alt} error={altError} onChange={(e) => setAlt(e.target.value)} />
        <Input label="Caption (optional)" value={caption} onChange={(e) => setCaption(e.target.value)} />
        {upload.isError && (
          <p role="alert" className="text-body text-danger">
            {errorMessage(upload.error)}
          </p>
        )}
      </div>
    </Dialog>
  );
}
